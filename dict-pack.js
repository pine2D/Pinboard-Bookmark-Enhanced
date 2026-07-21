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

// Streaming line splitter over a (possibly gzip) ReadableStream. The
// TextDecoderStream handles UTF-8 across byte chunks; `carry` handles lines
// across text chunks. fatal:true rejects on invalid UTF-8 (wrong file).
// stats.bytes counts DECOMPRESSED bytes (64MB hard cap; stored in meta).
// The line-length check runs BEFORE the yield too -- a 70KB line whose
// newline arrives in the same chunk must not slip through.
async function* pbpCedictLines(stream, gzip, stats) {
  stats = stats || { bytes: 0 };
  stats.bytes = 0;
  let text = stream;
  if (gzip) text = text.pipeThrough(new DecompressionStream("gzip"));
  text = text.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      stats.bytes += chunk.byteLength;
      if (stats.bytes > 64 * 1024 * 1024) throw new Error("CEDICT file too large");
      controller.enqueue(chunk);
    }
  }));
  text = text.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
  let carry = "";
  for await (const chunk of text) {
    carry += chunk;
    let end;
    while ((end = carry.indexOf("\n")) !== -1) {
      if (end > 65536) throw new Error("CEDICT line too long");
      let line = carry.slice(0, end);
      carry = carry.slice(end + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
    if (carry.length > 65536) throw new Error("CEDICT line too long");
  }
  if (carry) yield carry.endsWith("\r") ? carry.slice(0, -1) : carry;
}

// ---- PURE END ----

// ---- IDB layer (DB pbp-dict-packs) --------------------------------------
const _PBP_PACK_DB = "pbp-dict-packs";
const _PBP_PACK_STORE = "cedict";
const _PBP_PACK_META = "packs";
let _pbpPackDbPromise = null;

function _pbpPackOpenDB() {
  if (_pbpPackDbPromise) return _pbpPackDbPromise;
  _pbpPackDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_PBP_PACK_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Inline autoIncrement id: getAll() only returns VALUES, so the id
      // must live in the record for merge/dedup/sort to see it.
      const store = db.createObjectStore(_PBP_PACK_STORE, { keyPath: "id", autoIncrement: true });
      store.createIndex("simp", "simp", { unique: false });
      store.createIndex("trad", "trad", { unique: false });
      db.createObjectStore(_PBP_PACK_META, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _pbpPackDbPromise = null; reject(req.error || new Error("pack db open failed")); };
  });
  return _pbpPackDbPromise;
}

function _pbpPackTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([_PBP_PACK_STORE, _PBP_PACK_META], mode);
    let out;
    try { out = fn(tx); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out && typeof out.value === "function" ? out.value() : out);
    tx.onabort = () => reject(tx.error || new Error("pack tx aborted"));
    tx.onerror = () => reject(tx.error || new Error("pack tx failed"));
  });
}

// Import: Web Locks serialize writers; first tx deletes meta AND clears the
// store in ONE transaction (old meta gone = half-pack invisible); batched
// puts; meta {state:"ready"} written LAST. A tab closed mid-import leaves
// no meta -> lookups refuse the data.
async function pbpPackImport(lineIter, onProgress, stats) {
  return navigator.locks.request("pbp-cedict-import", async () => {
    const db = await _pbpPackOpenDB();
    await _pbpPackTx(db, "readwrite", (tx) => {
      tx.objectStore(_PBP_PACK_META).delete("cedict");
      tx.objectStore(_PBP_PACK_STORE).clear();
    });
    let batch = [];
    let entries = 0;
    let malformed = 0;
    const flush = () => _pbpPackTx(db, "readwrite", (tx) => {
      const store = tx.objectStore(_PBP_PACK_STORE);
      for (const rec of batch) store.put(rec);
      batch = [];
    });
    for await (const line of lineIter) {
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
  });
}

// Lookup: meta gate and index reads share ONE readonly transaction. For each
// key BOTH indexes are queried and results merged (a form that is someone's
// simp and someone else's trad must surface both records).
async function pbpPackLookup(keys) {
  const db = await _pbpPackOpenDB();
  return new Promise((resolve) => {
    const tx = db.transaction([_PBP_PACK_STORE, _PBP_PACK_META], "readonly");
    const metaReq = tx.objectStore(_PBP_PACK_META).get("cedict");
    metaReq.onsuccess = () => {
      const meta = metaReq.result;
      if (!meta || meta.state !== "ready") { resolve(null); return; }
      const store = tx.objectStore(_PBP_PACK_STORE);
      const tryKey = (i) => {
        if (i >= keys.length) { resolve(null); return; }
        const key = keys[i];
        const bySimp = store.index("simp").getAll(key);
        bySimp.onsuccess = () => {
          const byTrad = store.index("trad").getAll(key);
          byTrad.onsuccess = () => {
            const seen = new Set();
            const rows = [];
            for (const r of [...(bySimp.result || []), ...(byTrad.result || [])]) {
              if (seen.has(r.id)) continue;
              seen.add(r.id);
              rows.push(r);
            }
            rows.sort((a, b) => a.id - b.id); // storage order across both indexes
            if (rows.length) resolve({ matched: key, rows });
            else tryKey(i + 1);
          };
          byTrad.onerror = () => resolve(null);
        };
        bySimp.onerror = () => resolve(null);
      };
      tryKey(0);
    };
    metaReq.onerror = () => resolve(null);
  });
}

async function pbpPackMeta() {
  try {
    const db = await _pbpPackOpenDB();
    return await new Promise((resolve) => {
      const req = db.transaction(_PBP_PACK_META, "readonly").objectStore(_PBP_PACK_META).get("cedict");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
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
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const stats = { bytes: 0 };
  return pbpPackImport(pbpCedictLines(file.stream(), gzip, stats), onProgress, stats);
}
