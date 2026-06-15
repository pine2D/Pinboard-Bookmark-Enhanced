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

// ============================================================
// View-layer pure helpers (unit-tested in tests/md-ai-tests.html)
// ============================================================

// Entry visibility (spec 4.1): hide the translate control ONLY when the
// detected article language AND the UI language are both non-empty and
// equal. Uncertain detection ("" for Latin scripts) always shows it.
function _pbpTrShouldHideEntry(articleLang, uiLang) {
  return !!(articleLang && uiLang && articleLang === uiLang);
}

// Target-language resolution: "auto" -> the UI language (BCP-47 from
// uiLangToBCP47(), passed in by the caller so this stays pure); otherwise
// the stored code / custom free text. `code` keys the tr_/trview_ cache;
// `name` is the human-readable targetLanguage sent in the prompt.
const PBP_TR_LANG_NAMES = {
  "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese",
  en: "English", ja: "Japanese", ko: "Korean", de: "German", fr: "French",
  es: "Spanish", pt: "Portuguese", ru: "Russian", it: "Italian", pl: "Polish",
  nl: "Dutch", tr: "Turkish", ar: "Arabic", hi: "Hindi", vi: "Vietnamese",
  th: "Thai", id: "Indonesian"
};

function pbpTrResolveTargetLang(s, uiLang) {
  const v = String((s && s.translateTargetLang) || "auto").trim() || "auto";
  const code = v === "auto" ? String(uiLang || "en") : v;
  return { code, name: PBP_TR_LANG_NAMES[code] || code };
}

// Export composition (window.pbpViewMarkdown): items = [{orig, tr|null}]
// in document order over ALL blocks (pre blocks carry tr:null).
// bilingual -> orig + tr interleaved; translated -> tr with orig fallback.
function pbpTrComposeView(mode, items) {
  const parts = [];
  for (const it of (items || [])) {
    const orig = (it && it.orig) ? String(it.orig) : "";
    const tr = (it && typeof it.tr === "string" && it.tr.trim()) ? it.tr : null;
    if (mode === "bilingual") {
      if (orig) parts.push(orig);
      if (tr) parts.push(tr);
    } else {
      const pick = tr || orig;
      if (pick) parts.push(pick);
    }
  }
  return parts.join("\n\n");
}

// ============================================================
// DOM / UI layer. Lazily mounted: pbpTrInit runs on "pbp:rendered",
// builds the rail section only when gating passes; everything heavier
// (view toggle) mounts on first use. document.getElementById style
// (md-preview pages do not load shared.js's $id).
// ============================================================

const PBP_TR_ERR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>';
const PBP_TR_BTN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h8"/><path d="M8 3v2c0 4-2.5 7.5-5 9"/><path d="M5 9c1.5 2.5 4 4.5 7 5"/><path d="M14 21l4-9 4 9"/><path d="M15.5 17.5h5"/></svg>';

let _pbpTrState = null;

async function pbpTrInit(detail) {
  const view = document.getElementById("rendered-view");
  if (!view || _pbpTrState) return;
  const s = await pbpAiGetSettings();
  if (!pbpAiAvailable(s)) return; // master switch off or no key: zero UI
  const uiLang = uiLangToBCP47();
  if (_pbpTrShouldHideEntry(view.lang || "", uiLang)) return;
  if (!pbpAiBlocks().length) pbpAiIndexBlocks(view);

  const st = _pbpTrState = {
    s,
    url: String((detail && detail.url) || ""),
    title: String((detail && detail.title) || ""),
    target: pbpTrResolveTargetLang(s, uiLang),
    modelKey: (s.aiProvider || "gemini") + ":" + (pbpAiResolveModelOverride(s) || "default"),
    work: [],                      // non-pre blocks: {n, md, hash, shielded:{text,slots}}
    trMd: Object.create(null),     // n -> RESTORED translated markdown (export + TOC)
    mode: "original",
    running: false,
    ctrl: null
  };
  for (const b of pbpAiBlocks()) {
    if (b.tag === "pre") continue;                 // code blocks never travel (spec 4.4)
    const md = pbpAiMdOf(b.n);
    if (!md.trim()) continue;
    st.work.push({ n: b.n, md, hash: pbpAiHash(md), shielded: pbpAiShield(md) });
  }
  if (!st.work.length) return;
  _pbpTrBuildSection(st);

  // tr-only escape hatch: click a translated block to peek at its original.
  view.addEventListener("click", (e) => {
    if (!document.body.classList.contains("tr-only")) return;
    const tr = e.target.closest(".pb-tr");
    if (!tr || e.target.closest("a")) return;      // never hijack links
    const orig = tr.previousElementSibling;
    if (orig && orig.dataset && orig.dataset.pb) orig.classList.toggle("pb-show-orig");
  });
  // Page close terminates every in-flight request (error matrix last row).
  window.addEventListener("pagehide", () => { if (st.ctrl) st.ctrl.abort(); });

  // Cache probe (partial-hit aware): full hit -> zero requests + restore the
  // remembered view; partial hit -> fill what we have, button says Continue.
  try {
    const cached = await pbpTrCacheGet(st.url, st.target.code, st.modelKey);
    if (cached) {
      let hits = 0;
      for (const w of st.work) {
        const ttext = cached.blocks[w.hash];
        if (typeof ttext === "string") { _pbpTrFill(st, w, ttext); hits++; }
      }
      if (hits === st.work.length) {
        _pbpTrSetStatus(st, "done");
        _pbpTrShowViewToggle(st);
        const v = await pbpTrViewGet(st.url);
        if (v && v.lang === st.target.code && (v.mode === "bilingual" || v.mode === "translated")) {
          _pbpTrSetMode(st, v.mode, false);
        }
      } else if (hits > 0) {
        _pbpTrSetStatus(st, "partial");
        _pbpTrShowViewToggle(st);
      }
    }
  } catch (_) {}
}

function _pbpTrBuildSection(st) {
  const rail = document.getElementById("rail");
  const anchor = rail ? rail.querySelector(".view-toggle") : null;
  if (!anchor || document.getElementById("tr-section")) return;
  const sec = document.createElement("div");
  sec.className = "rail-section";
  sec.id = "tr-section";

  const label = document.createElement("div");
  label.className = "rail-label";
  label.textContent = t("trTranslate");
  sec.appendChild(label);

  const row = document.createElement("div");
  row.className = "tr-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btn-translate";
  btn.className = "action-btn";
  btn.innerHTML = PBP_TR_BTN_SVG;                  // static inline SVG only
  const bl = document.createElement("span");
  bl.className = "btn-label";
  bl.textContent = t("trTranslate");
  btn.appendChild(bl);
  row.appendChild(btn);
  const stop = document.createElement("button");
  stop.type = "button";
  stop.id = "btn-tr-stop";
  stop.className = "action-btn";
  stop.textContent = t("trStop");
  stop.hidden = true;
  row.appendChild(stop);
  sec.appendChild(row);

  // Cost transparency BEFORE the first request (spec 4.1): chars/4 x 2.
  const est = document.createElement("div");
  est.id = "tr-estimate";
  est.className = "tr-meta";
  const chars = st.work.reduce((a, w) => a + w.shielded.text.length, 0);
  est.textContent = t("trEstCost", String(pbpAiEstimateTokens(chars) * 2),
    (st.s.aiProvider || "gemini") + "/" + (pbpAiResolveModelOverride(st.s) || "default"));
  sec.appendChild(est);

  const prog = document.createElement("div");
  prog.id = "tr-progress";
  prog.className = "tr-meta";
  prog.setAttribute("role", "status");
  prog.setAttribute("aria-live", "polite");
  prog.hidden = true;
  sec.appendChild(prog);

  anchor.insertAdjacentElement("afterend", sec);
  btn.addEventListener("click", () => { _pbpTrStart(st).catch(() => {}); });
  stop.addEventListener("click", () => { if (st.ctrl) st.ctrl.abort(); });
}

async function _pbpTrStart(st) {
  if (st.running) return;
  const pending = st.work.filter((w) => !(w.n in st.trMd));
  if (!pending.length) { _pbpTrSetStatus(st, "done"); _pbpTrShowViewToggle(st); return; }
  st.running = true;
  st.ctrl = new AbortController();
  pbpAiBumpCounter("translate");
  _pbpTrSetStatus(st, "translating");

  // Context enrichment: reuse the ALREADY-CACHED AI summary if present
  // (never generates one — strict user-invoked rule). Source mirrors the
  // md-preview source badge: "jina" | "local".
  let summary = "";
  try {
    const activeSeg = document.querySelector("#source-badge .src-seg.active");
    const source = (activeSeg && activeSeg.getAttribute("data-engine") === "jina") ? "jina" : "local";
    summary = (await getAICache(st.url, "summary", st.s.aiCacheDuration, source)) || "";
  } catch (_) {}
  const glossary = pbpTrParseGlossary(st.s.translateGlossary);
  const model = pbpAiResolveModelOverride(st.s);
  const baseArgs = { targetLanguage: st.target.name, title: st.title, summary, glossary };
  const streamOpts = (charLen) => ({
    system: "", model, signal: st.ctrl.signal,
    temperature: 0.1, noThinking: true,
    maxTokens: Math.min(8192, Math.max(1024, pbpAiEstimateTokens(charLen) * 3))
  });

  const requestBatch = (segments, onItem) => {
    const { system, prompt } = pbpTrBuildPrompt({ ...baseArgs, segments });
    const parser = pbpAiMakeStreamJsonParser(onItem);
    const opts = streamOpts(segments.reduce((a, x) => a + x.text.length, 0));
    opts.system = system;
    const key = "tr:" + st.modelKey + ":" + st.target.code + ":" + segments.map((x) => x.id).join(",");
    return getOrCreateInflight(key, () =>
      callAIStream(st.s, prompt, opts, (d, acc) => parser.push(acc))
    ).then((full) => parser.finish(full));
  };
  const requestSingle = async (seg) => {
    const { system, prompt } = pbpTrBuildPrompt({ ...baseArgs, segments: [seg] });
    let got = null;
    const parser = pbpAiMakeStreamJsonParser((it) => { if (it.id === seg.id) got = it.text; });
    const opts = streamOpts(seg.text.length);
    opts.system = system;
    const full = await callAIStream(st.s, prompt, opts, (d, acc) => parser.push(acc));
    parser.finish(full);
    return got;
  };

  const byId = new Map(st.work.map((w) => [w.n, w]));
  const newly = {};                                 // blockHash -> shielded translation
  await pbpTrRunQueue({
    batches: pbpTrPackBatches(pending.map((w) => ({ id: w.n, text: w.shielded.text }))),
    requestBatch, requestSingle, signal: st.ctrl.signal,
    onFill: (id, text) => {
      const w = byId.get(id);
      if (!w) return;
      _pbpTrFill(st, w, text);
      newly[w.hash] = text;
    },
    onBlockFail: (id, message) => {
      const w = byId.get(id);
      if (w) _pbpTrMarkFailed(st, w, message);
    },
    onProgress: (done, total) => {
      const prog = document.getElementById("tr-progress");
      if (prog) prog.textContent = t("trProgress", String(done), String(total));
    }
  });
  st.running = false;
  if (Object.keys(newly).length) {
    try { await pbpTrCacheSet(st.url, st.target.code, st.modelKey, newly); } catch (_) {}
  }
  const doneAll = st.work.every((w) => (w.n in st.trMd));
  if (doneAll) {
    _pbpTrSetStatus(st, "done");
    _pbpTrShowViewToggle(st);
    if (st.mode === "original") _pbpTrSetMode(st, "bilingual", true);
  } else {
    _pbpTrSetStatus(st, "partial");                 // Stop / failures: Continue
    if (Object.keys(st.trMd).length) _pbpTrShowViewToggle(st);
  }
}

// Fill one block: restore placeholders, render via renderMarkdown (the
// SINGLE sanitize point), insert/replace the .pb-tr sibling, strip ids the
// renderer slugged inside the copy (heading ids always derive from the
// ORIGINAL, spec 4.4), then re-render KaTeX in the translated block.
function _pbpTrFill(st, w, shieldedTranslation) {
  const restored = pbpAiRestore(shieldedTranslation, w.shielded.slots);
  st.trMd[w.n] = restored;
  const orig = pbpAiBlockEl(w.n);
  if (!orig) return;
  const sib = orig.nextElementSibling;
  if (sib && sib.classList && sib.classList.contains("pb-tr-err")) sib.remove();
  let div = (orig.nextElementSibling && orig.nextElementSibling.classList
    && orig.nextElementSibling.classList.contains("pb-tr")) ? orig.nextElementSibling : null;
  if (!div) {
    div = document.createElement("div");
    div.className = "pb-tr";
    div.dataset.pbTr = String(w.n);
    orig.insertAdjacentElement("afterend", div);
  }
  div.innerHTML = renderMarkdown(restored);
  div.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  div.title = t("trShowOriginal");
  orig.dataset.pbTrDone = "1";
  // KaTeX: only when the article actually rendered math (md-preview gated
  // loading on info.math; a .katex node proves it). ensureKatex is a
  // top-level function in md-preview.js, visible here.
  if (/\$/.test(div.textContent)
      && (typeof renderMathInElement === "function" || document.querySelector("#rendered-view .katex"))) {
    ensureKatex().then(() => {
      if (typeof renderMathInElement !== "function") return;
      try {
        renderMathInElement(div, {
          delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
          throwOnError: false
        });
      } catch (_) {}
    });
  }
}

// Per-block failure: inline error pill after the block. Hover (title) shows
// the error; click retries this single block.
function _pbpTrMarkFailed(st, w, message) {
  const orig = pbpAiBlockEl(w.n);
  if (!orig) return;
  const sib = orig.nextElementSibling;
  if (sib && sib.classList && (sib.classList.contains("pb-tr") || sib.classList.contains("pb-tr-err"))) sib.remove();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pb-tr-err";
  btn.dataset.pbTrErr = String(w.n);
  btn.title = t("trBlockFailed") + " - " + String(message || "");
  btn.innerHTML = PBP_TR_ERR_SVG;                   // static inline SVG only
  const lab = document.createElement("span");
  lab.textContent = t("trRetryBlock");
  btn.appendChild(lab);
  orig.insertAdjacentElement("afterend", btn);
  btn.addEventListener("click", () => { _pbpTrRetryBlock(st, w, btn).catch(() => {}); });
}

async function _pbpTrRetryBlock(st, w, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const glossary = pbpTrParseGlossary(st.s.translateGlossary);
  const { system, prompt } = pbpTrBuildPrompt({
    targetLanguage: st.target.name, title: st.title, glossary,
    segments: [{ id: w.n, text: w.shielded.text }]
  });
  try {
    let got = null;
    const parser = pbpAiMakeStreamJsonParser((it) => { if (it.id === w.n) got = it.text; });
    const full = await callAIStream(st.s, prompt, {
      system, model: pbpAiResolveModelOverride(st.s),
      temperature: 0.1, noThinking: true, maxTokens: 4096
    }, (d, acc) => parser.push(acc));
    parser.finish(full);
    if (typeof got !== "string" || !pbpTrLengthRatioOk(w.shielded.text, got)) {
      throw new Error("invalid single-block translation");
    }
    btn.remove();
    _pbpTrFill(st, w, got);
    const one = {};
    one[w.hash] = got;
    try { await pbpTrCacheSet(st.url, st.target.code, st.modelKey, one); } catch (_) {}
    _pbpTrShowViewToggle(st);
    if (st.work.every((x) => x.n in st.trMd)) _pbpTrSetStatus(st, "done");
  } catch (e) {
    btn.disabled = false;
    btn.title = t("trBlockFailed") + " - " + String((e && e.message) || "");
  }
}

function _pbpTrSetStatus(st, status) {
  const btn = document.getElementById("btn-translate");
  const stop = document.getElementById("btn-tr-stop");
  const prog = document.getElementById("tr-progress");
  const est = document.getElementById("tr-estimate");
  if (!btn) return;
  const label = btn.querySelector(".btn-label");
  if (status === "translating") {
    label.textContent = t("trTranslating");
    btn.disabled = true;
    stop.hidden = false;
    prog.hidden = false;
    est.hidden = true;
  } else if (status === "partial") {
    label.textContent = t("trContinue");
    btn.disabled = false;
    btn.hidden = false;
    stop.hidden = true;
  } else if (status === "done") {
    btn.hidden = true;
    stop.hidden = true;
    prog.hidden = true;
    est.hidden = true;
  }
}

// Three-state view. mode: "original" | "bilingual" | "translated".
// Pure DOM show/hide — zero re-requests (spec 4.2). Persisted per URL.
function _pbpTrShowViewToggle(st) {
  if (document.getElementById("tr-view-toggle")) return;
  const wrap = document.createElement("div");
  wrap.id = "tr-view-toggle";
  wrap.className = "view-toggle";
  for (const [mode, key] of [["original", "trViewOriginal"], ["bilingual", "trViewBilingual"], ["translated", "trViewTranslated"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toggle-btn";
    b.dataset.trMode = mode;
    b.textContent = t(key);
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => _pbpTrSetMode(st, mode, true));
    wrap.appendChild(b);
  }
  document.getElementById("tr-section").appendChild(wrap);
  _pbpTrSyncToggle(st.mode);
}

function _pbpTrSyncToggle(mode) {
  document.querySelectorAll("#tr-view-toggle .toggle-btn").forEach((b) => {
    const active = b.dataset.trMode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function _pbpTrSetMode(st, mode, persist) {
  st.mode = mode;
  document.body.classList.toggle("tr-bilingual", mode === "bilingual");
  document.body.classList.toggle("tr-only", mode === "translated");
  if (mode !== "translated") {
    document.querySelectorAll("#rendered-view .pb-show-orig").forEach((el) => el.classList.remove("pb-show-orig"));
  }
  _pbpTrSyncToggle(mode);
  _pbpTrSyncToc(st, mode);
  // Export follows the view: md-preview.js consults window.pbpViewMarkdown
  // (function in bilingual/translated, null in original) before getMarkdown().
  window.pbpViewMarkdown = (mode === "original") ? null
    : () => pbpTrComposeView(mode, pbpAiBlocks().map((b) => ({ orig: pbpAiMdOf(b.n), tr: st.trMd[b.n] || null })));
  if (persist) pbpTrViewSet(st.url, { mode, lang: st.target.code }).catch(() => {});
}

// TOC text swap (spec 4.4: translated-only view follows translated heading
// text; anchors/ids never change). Originals stashed on the link, restored
// on any other view.
function _pbpTrSyncToc(st, mode) {
  document.querySelectorAll("#toc-list a[data-slug]").forEach((a) => {
    if (mode === "translated") {
      const headEl = document.getElementById(a.dataset.slug);
      if (!headEl || !headEl.dataset.pb) return;
      const sib = headEl.nextElementSibling;
      if (!sib || !sib.classList.contains("pb-tr")) return;
      const txt = sib.textContent.trim();
      if (!txt) return;
      if (a.dataset.origText == null) a.dataset.origText = a.textContent;
      a.textContent = txt;
    } else if (a.dataset.origText != null) {
      a.textContent = a.dataset.origText;
    }
  });
}

// Init hookup: top-level listener registration only (no other side effects;
// the tests page loads this file on file:// and never fires the event).
if (typeof document !== "undefined") {
  document.addEventListener("pbp:rendered", (e) => {
    pbpTrInit((e && e.detail) || {}).catch(() => {});
  }, { once: true });
}
