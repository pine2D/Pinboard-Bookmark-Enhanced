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
    if (!b || typeof b.text !== "string") continue;
    const len = b.text.length;
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
  payload.segments = Array.isArray(a.segments)
    ? a.segments.map(function (s) { return { id: s.id, text: s.text }; })
    : [];
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

// ============================================================
// Batch queue engine (DOM-free; all I/O injected for testability)
// ============================================================

// 429 detection. handleAIError does NOT set err.status -- it bakes the HTTP
// status into the message ("<provider> failed (HTTP 429)") or passes the
// provider's own wording through; match both, plus err.status for safety.
function _pbpTrIs429(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  return /HTTP 429|rate.?limit|too many requests|resource.*exhausted/i.test(String(err.message || ""));
}

function _pbpTrMissingIds(batch, filledSet) {
  const out = [];
  for (const seg of batch) { if (!filledSet.has(seg.id)) out.push(seg.id); }
  return out;
}

const PBP_TR_BACKOFF_MS = [2000, 8000, 32000];

// pbpTrRunQueue(plan) -> Promise<{done, total, failed:[{id,message}], stopped}>
//   plan: {
//     batches:      [[{id, text}]]            (pbpTrPackBatches output; text = SHIELDED md)
//     requestBatch: async (segments, onItem) -> {seenIds:Set}
//                   (streams; calls onItem({id,text}) per closed item; resolves
//                    with the finish() diff set; rejects with handleAIError /
//                    timeout / AbortError semantics)
//     requestSingle:async (segment) -> string|null  (downgrade path: one block,
//                    one attempt; null = model returned nothing usable)
//     onFill(id, text), onBlockFail(id, message), onProgress(done, total)
//     signal?:      AbortSignal (Stop button / page close)
//     concurrency?: default 2; backoffMs?: default PBP_TR_BACKOFF_MS (tests
//                   inject [1,1,1]); sleep?: default setTimeout promise
//   }
// Resolution invariants: resolves (never rejects) -- every non-filled block is
// either in `failed` or still pending because `stopped` is true. The ratio
// gate (pbpTrLengthRatioOk) runs on every fill, batch AND single.
async function pbpTrRunQueue(plan) {
  const batches = plan.batches || [];
  const conc = plan.concurrency || 2;
  const backoff = plan.backoffMs || PBP_TR_BACKOFF_MS;
  const sleep = plan.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const signal = plan.signal;
  const aborted = () => !!(signal && signal.aborted);

  const total = batches.reduce((n, b) => n + b.length, 0);
  const filled = new Set();
  const failed = [];
  let done = 0;
  const downgrade = [];   // [{id, text}] -> single-block retry phase
  let slow = false;       // any 429 seen -> drain pool to 1 worker
  let next = 0;           // next batch index to claim

  const fill = (id, text) => {
    if (filled.has(id)) return;
    filled.add(id);
    done += 1;
    try { plan.onFill(id, text); } catch (_) {}
    try { plan.onProgress(done, total); } catch (_) {}
  };
  const fail = (id, message) => {
    failed.push({ id, message: String(message || "translation failed") });
    try { plan.onBlockFail(id, String(message || "translation failed")); } catch (_) {}
  };

  async function runBatch(batch) {
    const byId = new Map(batch.map((s) => [s.id, s]));
    const onItem = (item) => {
      const seg = byId.get(item.id);
      if (!seg || filled.has(item.id)) return;            // out-of-batch / dup id: skip
      if (pbpTrLengthRatioOk(seg.text, item.text)) fill(item.id, item.text);
      // ratio-failed items stay unfilled -> picked up by the missing diff below
    };
    for (let attempt = 0; ; attempt++) {
      if (aborted()) return;
      try {
        await plan.requestBatch(batch, onItem);
        break; // stream completed; missing-id diff below
      } catch (e) {
        if (aborted()) return;
        if (_pbpTrIs429(e) && attempt < backoff.length) {
          slow = true;                                     // 2 -> 1 worker
          await sleep(backoff[attempt]);
          continue;
        }
        // hard batch failure: every unfilled block gets the inline error
        for (const id of _pbpTrMissingIds(batch, filled)) fail(id, e && e.message);
        return;
      }
    }
    // stream OK: ids missing from the answer (or ratio-rejected) -> downgrade
    for (const id of _pbpTrMissingIds(batch, filled)) downgrade.push(byId.get(id));
  }

  async function worker(index) {
    while (true) {
      if (aborted()) return;
      if (slow && index > 0) return;                       // pool 2 -> 1 after a 429
      const i = next++;
      if (i >= batches.length) return;
      await runBatch(batches[i]);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(conc, Math.max(batches.length, 1)); w++) workers.push(Promise.resolve(worker(w)).catch(function (e) { void e; }));
  await Promise.all(workers);

  // Downgrade phase: sequential single-block re-request, ONE attempt each
  // (spec: retry once, don't grind the same prompt repeatedly).
  while (downgrade.length) {
    if (aborted()) break;
    const seg = downgrade.shift();
    if (!seg || filled.has(seg.id)) continue;
    try {
      const text = await plan.requestSingle(seg);
      if (typeof text === "string" && pbpTrLengthRatioOk(seg.text, text)) fill(seg.id, text);
      else fail(seg.id, "invalid single-block translation");
    } catch (e) {
      if (aborted()) break;
      fail(seg.id, e && e.message);
    }
  }

  return { done, total, failed, stopped: aborted() };
}
