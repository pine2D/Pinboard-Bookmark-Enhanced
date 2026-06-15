// ============================================================
// Pinboard Bookmark Enhanced - md-preview AI core (block index,
// placeholders, stream parsing, gating, IDB key conventions).
// Loaded ONLY by md-preview.html (after md-preview.js). Top level
// defines functions + module state only: no DOM/chrome side effects,
// so tests/md-ai-tests.html can load it on file://.
// Consumers: md-translate.js / md-ask.js (init on "pbp:rendered").
// ============================================================

// ---- Block index (shared by explain / ask / translate) ----
// Block id n is 1-based and triple-purpose: citation anchor [Pn] ->
// [data-pb="n"], translation slot (translated block = nextSibling),
// cache key component (blockHash = pbpAiHash(pbpAiMdOf(n))).
const PBP_AI_BLOCK_TAGS = ["P", "H2", "H3", "H4", "UL", "OL", "BLOCKQUOTE", "TABLE", "PRE"];
let _pbpAiBlockIndex = [];
let _pbpAiTextCache = Object.create(null);
let _pbpAiMdCache = Object.create(null);

function pbpAiIndexBlocks(rootEl) {
  _pbpAiBlockIndex = [];
  _pbpAiTextCache = Object.create(null);
  _pbpAiMdCache = Object.create(null);
  if (!rootEl) return _pbpAiBlockIndex;
  let n = 0;
  for (const el of rootEl.children) {
    if (PBP_AI_BLOCK_TAGS.indexOf(el.tagName) === -1) continue;
    n += 1;
    el.dataset.pb = String(n);
    _pbpAiBlockIndex.push({ n, el, tag: el.tagName.toLowerCase() });
  }
  return _pbpAiBlockIndex;
}

function pbpAiBlocks() {
  return _pbpAiBlockIndex;
}

function pbpAiBlockEl(n) {
  const b = _pbpAiBlockIndex[(Number(n) || 0) - 1];
  return b ? b.el : null;
}

function pbpAiTextOf(n) {
  const key = String(n);
  if (key in _pbpAiTextCache) return _pbpAiTextCache[key];
  const el = pbpAiBlockEl(n);
  const text = el ? (el.textContent || "") : "";
  if (el) _pbpAiTextCache[key] = text;
  return text;
}

// KaTeX pre-pass (translation fidelity): on a CLONE of the block, swap each
// rendered KaTeX tree for its TeX source pulled from the MathML annotation,
// wrapped back in $/$$ delimiters. Display math first (its wrapper contains
// a .katex child). Turndown then sees plain "$tex$" text. Note: Turndown's
// text escaping may add backslashes (e.g. _ -> \_); marked un-escapes them
// on re-render, and pbpAiShield treats the whole $...$ as one opaque slot,
// so the round trip is loss-free.
function _pbpAiKatexPrepass(clone) {
  clone.querySelectorAll(".katex-display").forEach((disp) => {
    const ann = disp.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
    const src = ann ? ann.textContent : (disp.textContent || "");
    disp.replaceWith(document.createTextNode("$$" + src + "$$"));
  });
  clone.querySelectorAll(".katex").forEach((k) => {
    const ann = k.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
    const src = ann ? ann.textContent : (k.textContent || "");
    k.replaceWith(document.createTextNode("$" + src + "$"));
  });
}

function pbpAiMdOf(n) {
  const key = String(n);
  if (key in _pbpAiMdCache) return _pbpAiMdCache[key];
  const el = pbpAiBlockEl(n);
  if (!el) return "";
  const clone = el.cloneNode(true);
  _pbpAiKatexPrepass(clone);
  let md;
  try {
    md = htmlToMarkdown(clone.outerHTML).trim();
  } catch (_) {
    md = (clone.textContent || "").trim();
  }
  _pbpAiMdCache[key] = md;
  return md;
}

// ---- FNV-1a 32-bit hash, hex string. Math.imul keeps the multiply in
// exact 32-bit space (plain * overflows 2^53 and corrupts the hash).
// Hashes UTF-16 code units (not UTF-8 bytes): consistent within this
// extension, which is all cache keys need.
function pbpAiHash(str) {
  const s = String(str == null ? "" : str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

// ---- Token estimate: chars/4 heuristic (spec: cost transparency only) ----
function pbpAiEstimateTokens(chars) {
  return Math.ceil((Number(chars) || 0) / 4);
}

// ---- Markdown placeholder shield (translation format fidelity) ----
// Replaces untranslatable spans with unique placeholders the prompt orders
// the model to keep verbatim; pbpAiRestore puts the originals back.
// Placeholder chars U+27E6/U+27E7 are outside the banned glyph range and
// never appear in real markdown. Order matters:
//   C inline code first (may contain $, urls, brackets)
//   M display then inline math (raw $...$ in non-rendered articles; the
//     KaTeX pre-pass in pbpAiMdOf also lands here as $tex$)
//   I whole images BEFORE links (image syntax embeds link syntax)
//   L link URLs only ([text]( stays visible so the text gets translated),
//     then remaining bare/autolink URLs
function pbpAiShield(md) {
  const slots = [];
  const counters = { C: 0, L: 0, I: 0, M: 0 };
  function take(kind, orig) {
    counters[kind] += 1;
    const ph = "⟦" + kind + counters[kind] + "⟧";
    slots.push({ ph, orig });
    return ph;
  }
  let text = String(md == null ? "" : md);
  text = text.replace(/``[^`]+``|`[^`\n]+`/g, (m) => take("C", m));
  text = text.replace(/\$\$[^$]+\$\$/g, (m) => take("M", m));
  // Inline math vs currency heuristic: "$5 and $6" (whitespace inside, no
  // TeX-ish chars) is prose and must stay translatable; anything with
  // \ ^ _ { } = or no internal whitespace is treated as math.
  text = text.replace(/\$([^$\n]+)\$/g, (m, inner) => {
    if (/\s/.test(inner) && !/[\\^_{}=]/.test(inner)) return m;
    return take("M", m);
  });
  text = text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, (m) => take("I", m));
  text = text.replace(/(\[[^\]\n]*\]\()([^)\n]+)(\))/g,
    (m, pre, url, post) => pre + take("L", url) + post);
  text = text.replace(/https?:\/\/[^\s<>()⟦⟧]+/g, (m) => take("L", m));
  return { text, slots };
}

function pbpAiRestore(text, slots) {
  const s = String(text == null ? "" : text);
  if (!slots || !slots.length) return s;
  const map = Object.create(null);
  for (const slot of slots) map[slot.ph] = slot.orig;
  // One pass: each placeholder maps to its original; an unknown/hallucinated
  // placeholder (not in the map) is left untouched. Replacement is via a
  // function callback, so no $-escaping pitfalls.
  return s.replace(/⟦[CLIM]\d+⟧/g, (m) => (m in map ? map[m] : m));
}
