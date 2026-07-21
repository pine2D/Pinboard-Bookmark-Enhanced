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
