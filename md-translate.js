// ============================================================
// Pinboard Bookmark Enhanced - md-preview full-text translation.
// Loaded ONLY by md-preview.html (after md-ai-core.js; the <script>
// tag is added when the DOM layer lands). This top section is PURE
// (no DOM / chrome.* / fetch) so tests/md-ai-tests.html can load the
// file on file://. Later sections append: the batch queue engine
// (failure ladder) and the rail UI / bilingual view layer.
// ============================================================

// ---- Batch packing (spec 4.3: greedy, document order) ----
// blocks: [{id, text}] where text is the SHIELDED block markdown
// (pbpAiShield output). Greedy fill: close the current batch when adding
// the next block would exceed maxBlocks or maxChars. A single oversize
// block still ships alone (the model may truncate it; the failure ladder
// catches that) — blocks are never silently dropped.
function pbpTrPackBatches(blocks, maxBlocks = 15, maxChars = 8000) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const b of (blocks || [])) {
    const len = (b && typeof b.text === "string") ? b.text.length : 0;
    if (cur.length && (cur.length >= maxBlocks || curChars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push({ id: b.id, text: b.text });
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---- Prompt builder (spec 4.3 JSON protocol) ----
// The model must answer ONLY {"translations":[{"id":N,"text":"..."}]} so
// pbpAiMakeStreamJsonParser can fill blocks incrementally and finish()
// can diff seenIds against the request (failure ladder step 1).
const PBP_TR_SYSTEM = [
  "You are a professional translator.",
  'Output ONLY a JSON object of the exact shape {"translations":[{"id":N,"text":"..."}]} - no markdown fences, no commentary, nothing else.',
  "Rules:",
  "1. Translate every segment's \"text\" into targetLanguage. Return exactly one item per input segment; ids must match the input ids exactly.",
  "2. Placeholders like ⟦C1⟧, ⟦L2⟧, ⟦I3⟧, ⟦M4⟧ are protected content: keep every placeholder verbatim and in position. Never translate, alter, drop or duplicate them.",
  "3. Preserve the markdown structure of each segment (headings #, list markers -, blockquote >, emphasis, tables). Do not translate proper nouns, code identifiers or product names.",
  "4. If a glossary object is provided, apply it strictly: a non-empty value means always translate the term that way; an empty value (\"\") means keep the term in its source language, untranslated.",
  "5. Translate faithfully; do not add, omit or summarize content.",
  "The optional title and summary fields are context only - do not translate or return them."
].join("\n");

function pbpTrBuildPrompt(args) {
  const a = args || {};
  const payload = {
    targetLanguage: String(a.targetLanguage || ""),
    title: String(a.title || "")
  };
  if (a.summary) payload.summary = String(a.summary);
  if (a.glossary && typeof a.glossary === "object" && Object.keys(a.glossary).length) {
    payload.glossary = a.glossary;
  }
  payload.segments = Array.isArray(a.segments) ? a.segments : [];
  return { system: PBP_TR_SYSTEM, prompt: JSON.stringify(payload) };
}

// ---- Glossary parsing (options textarea, one "term=translation" per line;
// empty right side = keep the term untranslated; split on the FIRST "=") ----
function pbpTrParseGlossary(str) {
  const out = {};
  for (const line of String(str == null ? "" : str).split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const term = line.slice(0, i).trim();
    if (!term) continue;
    out[term] = line.slice(i + 1).trim();
  }
  return out;
}

// ---- Hallucination probe (spec 4.3 ladder step 3) ----
// A translated block whose char-length ratio vs the original falls outside
// [0.3, 4] (inclusive) is judged invalid and re-queued for single-block
// retry. Bounds are wide on purpose: CJK<->Latin legitimately shrinks or
// grows a lot; only runaway repetition / empty answers should trip this.
function pbpTrLengthRatioOk(orig, translated) {
  const o = String(orig == null ? "" : orig).trim().length;
  const t = String(translated == null ? "" : translated).trim().length;
  if (o === 0 || t === 0) return false;
  const r = t / o;
  return r >= 0.3 && r <= 4;
}
