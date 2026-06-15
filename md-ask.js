// ============================================================
// Pinboard Bookmark Enhanced - md-ask.js (ask-the-page panel +
// selection explain; this file starts with the panel shell).
// Loaded ONLY by md-preview.html as the LAST script in the chain.
// Top level: function/const definitions + one "pbp:rendered"
// listener registration - no chrome.*/DOM side effects, so
// tests/md-ai-tests.html can load it on file://.
// Depends on: md-ai-core.js (pbpAi*/pbpAskHist*), ai.js
// (callAIStream/getOrCreateInflight), i18n.js (t/applyI18n),
// md-convert.js (renderMarkdown, used by the answer renderer).
// ============================================================

// ---- Inline SVG constants (project rule: no emoji/dingbat glyphs) ----
const PBP_ASK_BTN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
const PBP_ASK_CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const PBP_ASK_CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const PBP_ASK_SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

// ---- Pure: should the "a" hotkey ignore this event target? ----
function pbpAskIsTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

let _pbpAskState = null;

async function pbpAskInit(detail) {
  const view = document.getElementById("rendered-view");
  if (!view || _pbpAskState) return;
  const s = await pbpAiGetSettings();
  if (!pbpAiAvailable(s)) return; // master off / no key: no button, no hotkey, no bridge
  // Idempotent index guard: md-translate may have indexed already; an
  // unconditional re-index would reset its md/text caches mid-flight.
  if (!pbpAiBlocks().length) pbpAiIndexBlocks(view);
  if (!pbpAiBlocks().length) return;

  _pbpAskState = {
    s,
    url: String((detail && detail.url) || ""),
    title: String((detail && detail.title) || ""),
    panel: null,
    ctx: null,        // lazy context cache (filled by the send-flow task)
    running: false,
    ctrl: null        // shared AbortController (Stop button aborts it)
  };

  _pbpAskBuildRailEntry();

  // Hotkey "a" toggles the panel; Esc closes it. Guards: never while
  // typing (input/textarea/select/contenteditable) and never with any
  // modifier held. Esc coexistence: setupDrawer's own document-level Esc
  // handler owns the event while the rail drawer is open, and an open
  // [popover] (explain, top layer) closes itself first - we yield to both.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!_pbpAskIsOpen()) return;
      if (document.body.classList.contains("rail-open")) return;
      try { if (document.querySelector(":popover-open")) return; } catch (_) {}
      _pbpAskSetOpen(false);
      return;
    }
    if (e.key !== "a" && e.key !== "A") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (pbpAskIsTypingTarget(e.target)) return;
    e.preventDefault();
    _pbpAskSetOpen(!_pbpAskIsOpen());
  });

  // Bridge for the explain popover's "ask a follow-up" footer button:
  // opens the panel, optionally prefills the textarea, focuses it.
  // Only exists when gating passed (callers typeof-check it).
  window.pbpAskOpenPanel = function (prefillText) {
    _pbpAskSetOpen(true);
    const ta = document.getElementById("ask-input");
    if (ta) {
      if (typeof prefillText === "string" && prefillText) ta.value = prefillText;
      ta.focus();
    }
  };

  // Page close terminates any in-flight request (error matrix last row).
  window.addEventListener("pagehide", () => {
    if (_pbpAskState && _pbpAskState.ctrl) _pbpAskState.ctrl.abort();
  });
}

// Rail entry. Generated markup (exact):
//   <div class="rail-section" id="ask-section">
//     <button type="button" id="ask-open" class="action-btn ask-open-btn"
//             aria-expanded="false" aria-controls="ask-panel">
//       <svg ...PBP_ASK_BTN_SVG...></svg><span class="btn-label">Ask</span>
//     </button>
//   </div>
// Anchor: directly after #tr-section when the translate entry rendered,
// else after the Raw/Rendered .view-toggle (the same slot translate uses,
// so the rail order is: view-toggle, [tr-section], ask-section, Export).
function _pbpAskBuildRailEntry() {
  const rail = document.getElementById("rail");
  if (!rail || document.getElementById("ask-open")) return;
  const anchor = document.getElementById("tr-section") || rail.querySelector(".view-toggle");
  if (!anchor) return;
  const sec = document.createElement("div");
  sec.className = "rail-section";
  sec.id = "ask-section";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "ask-open";
  btn.className = "action-btn ask-open-btn";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "ask-panel");
  btn.innerHTML = PBP_ASK_BTN_SVG; // static inline SVG constant only
  const bl = document.createElement("span");
  bl.className = "btn-label";
  bl.textContent = t("askOpen");
  btn.appendChild(bl);
  sec.appendChild(btn);
  anchor.insertAdjacentElement("afterend", sec);
  btn.addEventListener("click", () => _pbpAskSetOpen(!_pbpAskIsOpen()));
}

// Lazy panel mount (first open pays the cost; spec 3.1 lazy-UI rule).
// The template is a STATIC string: no user/model text ever flows through
// this innerHTML (questions use textContent; answers stream as textContent
// and finalize through renderMarkdown(), the single sanitize point).
function _pbpAskBuildPanel() {
  if (!_pbpAskState) return null;
  if (_pbpAskState.panel) return _pbpAskState.panel;
  const panel = document.createElement("aside");
  panel.id = "ask-panel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "ask-title");
  panel.innerHTML = [
    '<header class="ask-head">',
    '  <h2 id="ask-title" data-i18n="askTitle">Ask the page</h2>',
    '  <button type="button" id="ask-clear" class="ask-ic" data-i18n-title="askClear" data-i18n-aria="askClear">' + PBP_ASK_CLEAR_SVG + '</button>',
    '  <button type="button" id="ask-close" class="ask-ic" data-i18n-title="askClose" data-i18n-aria="askClose">' + PBP_ASK_CLOSE_SVG + '</button>',
    '</header>',
    '<div id="ask-thread" role="log" aria-live="polite">',
    '  <p id="ask-empty" class="ask-empty" data-i18n="askEmptyHint"></p>',
    '</div>',
    '<div id="ask-chips">',
    '  <button type="button" class="ask-chip" data-i18n="askChipSummarize"></button>',
    '  <button type="button" class="ask-chip" data-i18n="askChipArgument"></button>',
    '  <button type="button" class="ask-chip" data-i18n="askChipData"></button>',
    '</div>',
    '<form id="ask-form">',
    '  <textarea id="ask-input" rows="2" data-i18n-placeholder="askPlaceholder"></textarea>',
    '  <div class="ask-actions">',
    '    <button type="button" id="ask-stop" class="action-btn" hidden data-i18n="askStop">Stop</button>',
    '    <button type="submit" id="ask-send" class="action-btn">' + PBP_ASK_SEND_SVG + '<span class="btn-label" data-i18n="askSend">Send</span></button>',
    '  </div>',
    '</form>',
    '<div id="ask-meta" aria-live="polite"></div>'
  ].join("\n");
  applyI18n(panel);
  document.body.appendChild(panel);
  _pbpAskState.panel = panel;

  panel.querySelector("#ask-close").addEventListener("click", () => _pbpAskSetOpen(false));
  // Clear seam: Task 15 appends _pbpAskShowClearConfirm (inline confirm
  // strip) to this same file - function declarations hoist file-wide, so
  // once Task 15 lands this click routes to the confirm strip; until then
  // it clears immediately. Single listener, no double-wiring.
  panel.querySelector("#ask-clear")._pbpWired = true;
  panel.querySelector("#ask-clear").addEventListener("click", () => {
    if (typeof _pbpAskShowClearConfirm === "function") { _pbpAskShowClearConfirm(); return; }
    _pbpAskClearThread().catch(() => {});
  });
  // Static starter chips (i18n text, zero tokens): click = put the chip
  // text into the textarea and send it through the submit seam.
  panel.querySelectorAll(".ask-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const ta = document.getElementById("ask-input");
      if (ta) ta.value = chip.textContent;
      _pbpAskOnSubmit();
    });
  });
  panel.querySelector("#ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    _pbpAskOnSubmit();
  });
  // Enter sends, Shift+Enter inserts a newline (spec 5.1).
  panel.querySelector("#ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      _pbpAskOnSubmit();
    }
  });
  return panel;
}

function _pbpAskIsOpen() {
  return document.body.classList.contains("ask-open");
}

// NON-MODAL by design: the panel is supplementary - answers cite the
// article and clicking a citation must scroll/highlight the original
// block, so the article has to stay scrollable, selectable and focusable
// while the panel is open. Therefore: no focus trap, no scrim, no
// aria-modal (deliberately UNLIKE setupDrawer's modal rail drawer, which
// overlays the page). Esc and the close button dismiss it.
function _pbpAskSetOpen(open) {
  const panel = _pbpAskBuildPanel();
  if (!panel) return;
  document.body.classList.toggle("ask-open", open);
  panel.hidden = !open;
  const btn = document.getElementById("ask-open");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // Transparency-line seam: implemented by the send-flow task.
    if (typeof _pbpAskUpdateMeta === "function") _pbpAskUpdateMeta();
    const ta = document.getElementById("ask-input");
    if (ta) ta.focus();
  }
}

// Clear: wipe the visible thread, restore starter chips + empty hint,
// and erase the persisted ask_<url> history.
async function _pbpAskClearThread() {
  const thread = document.getElementById("ask-thread");
  if (thread) {
    const empty = document.createElement("p");
    empty.id = "ask-empty";
    empty.className = "ask-empty";
    empty.textContent = t("askEmptyHint");
    thread.replaceChildren(empty);
  }
  const chips = document.getElementById("ask-chips");
  if (chips) chips.hidden = false;
  if (_pbpAskState) await pbpAskHistSet(_pbpAskState.url, []);
  _pbpAskHistRestored = false;
}

// Send-flow seam: _pbpAskSend lands in the next task (same file, function
// declarations hoist file-wide). Until then submit is a silent no-op
// (typeof on an undeclared identifier is safe, never a ReferenceError).
function _pbpAskOnSubmit() {
  if (typeof _pbpAskSend === "function") _pbpAskSend().catch(() => {});
}

// Init hookup: top-level listener registration only (no other side
// effects; the tests page loads this file on file:// and never fires it).
if (typeof document !== "undefined") {
  document.addEventListener("pbp:rendered", (e) => {
    pbpAskInit((e && e.detail) || {}).catch(() => {});
  }, { once: true });
}

// ============================================================
// Ask send pipeline (Task 13), part 1: pure functions.
// ============================================================

// Context budget in estimated tokens (chars/4; spec 5.1: ~24k, tunable).
const PBP_ASK_CTX_BUDGET = 24000;

// Layered context builder. blocks = pbpAiBlocks() entries ({n, el, tag}).
// Always keeps every heading block (h2/h3/h4) plus the first 3 and last 2
// blocks; the remaining budget is filled by sampling the leftover middle
// blocks at uniform document-order intervals (largest count that fits).
// Returns { text: "[Pn] <text>" lines joined by \n, sentBlocks, totalBlocks }.
function pbpAskBuildContext(blocks, budgetTokens) {
  const budget = (budgetTokens === undefined || budgetTokens === null)
    ? PBP_ASK_CTX_BUDGET : Number(budgetTokens);
  const list = Array.isArray(blocks) ? blocks : [];
  const totalBlocks = list.length;
  if (!totalBlocks) return { text: "", sentBlocks: 0, totalBlocks: 0 };
  const lineOf = (b) => "[P" + b.n + "] " +
    String((b.el && b.el.textContent) || "").replace(/\s+/g, " ").trim();
  const mandatory = [];
  const middle = [];
  list.forEach((b, i) => {
    const must = b.tag === "h2" || b.tag === "h3" || b.tag === "h4"
      || i < 3 || i >= totalBlocks - 2;
    (must ? mandatory : middle).push(b);
  });
  let baseChars = 0;
  for (const b of mandatory) baseChars += lineOf(b).length + 1;
  const midLens = middle.map((b) => lineOf(b).length + 1);
  // Largest k whose evenly-spaced sample fits the budget. O(middle^2)
  // worst case but middle is at most a few hundred blocks - negligible.
  let chosen = [];
  for (let k = middle.length; k >= 1; k--) {
    let chars = baseChars;
    for (let j = 0; j < k; j++) chars += midLens[Math.floor(j * middle.length / k)];
    if (pbpAiEstimateTokens(chars) <= budget) {
      for (let j = 0; j < k; j++) chosen.push(Math.floor(j * middle.length / k));
      break;
    }
  }
  const picked = new Set(mandatory.map((b) => b.n));
  for (const ix of chosen) picked.add(middle[ix].n);
  const lines = [];
  for (const b of list) if (picked.has(b.n)) lines.push(lineOf(b));
  return { text: lines.join("\n"), sentBlocks: lines.length, totalBlocks };
}

// Prompt builder. history = [{q, a}] (caller passes the in-memory rounds);
// only the last 4 are serialized. The CITES contract here is what
// pbpAiParseCites (md-ai-core, Task 5) parses on the way back.
function pbpAskBuildPrompt(args) {
  const a = args || {};
  const context = String(a.context == null ? "" : a.context);
  const question = String(a.question == null ? "" : a.question);
  const history = Array.isArray(a.history) ? a.history.slice(-4) : [];
  const system = [
    "You answer questions about ONE article supplied below.",
    "Rules:",
    "1. Answer in the same language as the question.",
    "2. Use ONLY the article. Do not use outside knowledge.",
    "3. After every claim the article supports, add an inline citation token [P<n>] where <n> is the paragraph number from the article.",
    "4. End the answer with a CITES: block - one line per cited paragraph, formatted exactly as:",
    "   P<n>: \"verbatim quote of 15 words or fewer, in the article's original language\"",
    "5. If the article does not contain the answer, say so plainly. Never invent citations."
  ].join("\n");
  const parts = ["ARTICLE:", context, ""];
  if (history.length) {
    parts.push("PREVIOUS Q&A (context for follow-ups only):");
    for (const h of history) {
      parts.push("Q: " + String((h && h.q) || ""));
      parts.push("A: " + String((h && h.a) || ""));
    }
    parts.push("");
  }
  parts.push("QUESTION: " + question);
  return { system, prompt: parts.join("\n") };
}

// ============================================================
// Ask send pipeline (Task 13), part 2: streaming send flow.
// Wires the Task 12 seams: _pbpAskOnSubmit -> _pbpAskSend and
// _pbpAskSetOpen -> _pbpAskUpdateMeta.
// ============================================================

// "provider" or "provider/override" - shown in the transparency line and
// persisted as the history record's model field.
function _pbpAskProviderLabel(s) {
  const provider = (s && s.aiProvider) || "gemini";
  const override = pbpAiResolveModelOverride(s);
  return override ? provider + "/" + override : provider;
}

// Transparency line (Task 12's _pbpAskSetOpen calls this seam on every
// open; the send path refreshes it again right before the request fires).
// Builds and caches the trimmed context on first need.
function _pbpAskUpdateMeta() {
  const st = _pbpAskState;
  const meta = document.getElementById("ask-meta");
  if (!st || !meta) return;
  // Context is built once from the ORIGINAL article and intentionally never
  // refreshes across translation/three-state changes -- the model stays
  // grounded on the original text so [Pn] citations resolve against original
  // paragraphs.
  if (!st.ctx) st.ctx = pbpAskBuildContext(pbpAiBlocks(), PBP_ASK_CTX_BUDGET);
  const _askQuestion = document.getElementById("ask-input");
  const _askQ = _askQuestion ? _askQuestion.value : "";
  const _askRounds = (st.rounds || []);
  const _askBuilt = st.ctx
    ? pbpAskBuildPrompt({ context: st.ctx.text, history: _askRounds, question: _askQ })
    : { system: "", prompt: "" };
  const tokens = pbpAiEstimateTokens((_askBuilt.system + _askBuilt.prompt).length);
  let line = t("askWillSend", String(tokens), _pbpAskProviderLabel(st.s));
  if (st.ctx.sentBlocks < st.ctx.totalBlocks) {
    line += " " + t("askSentPartial", String(st.ctx.sentBlocks), String(st.ctx.totalBlocks));
  }
  meta.textContent = line;
}

// One-time Stop wiring (the panel markup belongs to Task 12; same
// _pbpWired expando pattern the history task uses for #ask-clear).
function _pbpAskWireStop() {
  const btn = document.getElementById("ask-stop");
  if (!btn || btn._pbpWired) return;
  btn._pbpWired = true;
  btn.addEventListener("click", () => {
    if (_pbpAskState && _pbpAskState.ctrl) _pbpAskState.ctrl.abort();
  });
}

// Append one Q/A round. Question is USER text -> textContent only. The
// .ask-q/.ask-a structure is a cross-task contract (the history restore
// task replicates it verbatim).
function _pbpAskAppendRound(question) {
  const thread = document.getElementById("ask-thread");
  if (!thread) return null;
  const empty = document.getElementById("ask-empty");
  if (empty) empty.remove();
  const chips = document.getElementById("ask-chips");
  if (chips) chips.hidden = true;
  const qEl = document.createElement("div");
  qEl.className = "ask-q";
  qEl.textContent = question;
  const aEl = document.createElement("div");
  aEl.className = "ask-a streaming";
  thread.appendChild(qEl);
  thread.appendChild(aEl);
  thread.scrollTop = thread.scrollHeight;
  return aEl;
}

// Error UI: human message (callAIStream rejects with handleAIError text)
// plus a retry button that re-runs the SAME question into the same .ask-a.
function _pbpAskErrorUi(aEl, message, question) {
  const err = document.createElement("p");
  err.className = "ask-err";
  err.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "action-btn ask-retry";
  retry.textContent = t("askErrRetry");
  retry.addEventListener("click", () => {
    aEl.replaceChildren();
    aEl.classList.add("streaming");
    _pbpAskRun(question, aEl).catch(() => {});
  });
  aEl.appendChild(err);
  aEl.appendChild(retry);
}

// Core runner: stream into aEl, finalize, persist, count.
async function _pbpAskRun(question, aEl) {
  const st = _pbpAskState;
  if (!st || st.running) return;
  st.rounds = st.rounds || []; // lazy: Task 12's state object predates this field
  st.running = true;
  st.ctrl = new AbortController();
  _pbpAskWireStop();
  const stopBtn = document.getElementById("ask-stop");
  const sendBtn = document.getElementById("ask-send");
  if (stopBtn) stopBtn.hidden = false;
  if (sendBtn) sendBtn.disabled = true;
  let raf = 0;
  let acc = "";
  const paint = () => { raf = 0; aEl.textContent = acc; };
  try {
    if (!st.ctx) st.ctx = pbpAskBuildContext(pbpAiBlocks(), PBP_ASK_CTX_BUDGET);
    const built = pbpAskBuildPrompt({ context: st.ctx.text, history: st.rounds, question });
    const full = await getOrCreateInflight("ask_" + st.url + "_" + question, () =>
      callAIStream(st.s, built.prompt, {
        maxTokens: 4096,
        model: pbpAiResolveModelOverride(st.s),
        system: built.system,
        signal: st.ctrl.signal
      }, (d, accText) => {
        // rAF throttle: deltas land as plain textContent at most once per
        // frame; markdown renders exactly once, at finalize.
        acc = accText;
        if (!raf) raf = requestAnimationFrame(paint);
      })
    );
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    aEl.classList.remove("streaming");
    const parsed = _pbpAskFinalize(aEl, full);
    st.rounds.push({ q: question, a: parsed.body });
    // History read-modify-write is safe: st.running serializes sends so only
    // one answer finalizes at a time, making this sequence race-free.
    const hist = await pbpAskHistGet(st.url);
    hist.push({
      q: question,
      a: full,
      cites: parsed.cites,
      ts: Date.now(),
      model: _pbpAskProviderLabel(st.s)
    });
    await pbpAskHistSet(st.url, hist); // pbpAskHistSet caps at the last 20
    pbpAiBumpCounter("ask");
  } catch (e) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    aEl.classList.remove("streaming");
    aEl.textContent = acc; // keep whatever already streamed in
    if (e && e.name === "AbortError") {
      const note = document.createElement("p");
      note.className = "ask-stopped";
      note.textContent = t("askStopped");
      aEl.appendChild(note);
    } else {
      _pbpAskErrorUi(aEl, (e && e.message) ? e.message : String(e), question);
    }
  } finally {
    st.running = false;
    st.ctrl = null;
    if (stopBtn) stopBtn.hidden = true;
    if (sendBtn) sendBtn.disabled = false;
  }
}

// Submit seam target (Task 12's _pbpAskOnSubmit typeof-checks this name).
// Validation: non-empty question + gate; starter chips need nothing extra
// here (Task 12 already routes chip clicks through _pbpAskOnSubmit).
async function _pbpAskSend() {
  const st = _pbpAskState;
  if (!st || st.running) return;
  const ta = document.getElementById("ask-input");
  const question = ta ? ta.value.trim() : "";
  if (!question) { if (ta) ta.focus(); return; }
  if (!pbpAiAvailable(st.s)) return;
  _pbpAskUpdateMeta(); // refresh the transparency line BEFORE the request
  const aEl = _pbpAskAppendRound(question);
  if (!aEl) return;
  ta.value = "";
  await _pbpAskRun(question, aEl);
}

// ============================================================
// Citation pipeline (Task 14): parse -> render -> chips -> verify
// -> tooltip -> jump + flash. Replaces the Task 13 placeholder.
// ============================================================

// Pure tokenizer: split answer text into segments around [Pn] tokens.
// -> [{kind:"text", text}, {kind:"cite", p, token}, ...]; "" -> [].
// Drives the chip pass below (splits each text node at token boundaries,
// i.e. the splitText semantics, but unit-testable without a DOM).
function _pbpAskSplitCiteTokens(text) {
  const s = String(text == null ? "" : text);
  const re = /\[P(\d+)\]/g;
  const segs = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) segs.push({ kind: "text", text: s.slice(last, m.index) });
    segs.push({ kind: "cite", p: Number(m[1]), token: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ kind: "text", text: s.slice(last) });
  return segs;
}

// Chip pass: walk el's text nodes, replace every in-range [Pn] token with a
// superscript chip button; out-of-range tokens stay literal text (spec 5.2:
// failed verification must never render as a link). Verification (fuzzy
// quote locate) runs once per unique paragraph; chips are numbered
// sequentially per answer (data-seq) in reading order.
function _pbpAskChipPass(el, cites) {
  const maxP = pbpAiBlocks().length;
  // First quote wins when the model emits several CITES lines for one Pn.
  const quoteByP = new Map();
  for (const c of (Array.isArray(cites) ? cites : [])) {
    if (!quoteByP.has(c.p)) quoteByP.set(c.p, c.quote);
  }
  // pbpAiFuzzyFind already maps normalized hits back to RAW textContent
  // offsets (core.md Task 5: _pbpAiNormWithMap builds the index map and
  // mapBack applies it before returning), so {start,end} feed straight
  // into _pbpAskRangeFromOffsets at click time.
  const verifyByP = new Map();
  const verify = (p) => {
    if (!verifyByP.has(p)) {
      const quote = quoteByP.get(p);
      verifyByP.set(p, quote ? pbpAiFuzzyFind(quote, pbpAiTextOf(p)) : null);
    }
    return verifyByP.get(p);
  };
  // Collect first, mutate after: replacing nodes while the TreeWalker is
  // live skips siblings.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!/\[P\d+\]/.test(node.nodeValue)) continue;
    // [Pn] inside code/pre is answer content (e.g. a code sample), not a cite.
    if (node.parentElement && node.parentElement.closest("pre, code")) continue;
    nodes.push(node);
  }
  let seq = 0;
  for (const textNode of nodes) {
    const segs = _pbpAskSplitCiteTokens(textNode.nodeValue);
    const parent = textNode.parentNode;
    for (const seg of segs) {
      if (seg.kind === "text") {
        parent.insertBefore(document.createTextNode(seg.text), textNode);
        continue;
      }
      if (!(seg.p >= 1 && seg.p <= maxP)) {
        parent.insertBefore(document.createTextNode(seg.token), textNode);
        continue;
      }
      seq += 1;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ask-chip";
      chip.dataset.p = String(seg.p);
      chip.dataset.seq = String(seq);
      chip.textContent = String(seq);
      chip.setAttribute("aria-label", "P" + seg.p);
      const quote = quoteByP.get(seg.p);
      if (quote) chip.dataset.quote = quote;
      const hit = verify(seg.p);
      if (hit) {
        chip.dataset.qs = String(hit.start);
        chip.dataset.qe = String(hit.end);
        chip.classList.add("verified");
      }
      chip.addEventListener("click", () => _pbpAskJump(chip));
      chip.addEventListener("mouseenter", () => _pbpAskTipShow(chip));
      chip.addEventListener("mouseleave", _pbpAskTipHide);
      chip.addEventListener("focus", () => _pbpAskTipShow(chip));
      chip.addEventListener("blur", _pbpAskTipHide);
      parent.insertBefore(chip, textNode);
    }
    parent.removeChild(textNode);
  }
}

// Map raw textContent offsets [start, end) to a DOM Range by accumulating
// text-node lengths under blockEl (TreeWalker offset accumulation).
function _pbpAskRangeFromOffsets(blockEl, start, end) {
  if (!blockEl || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end <= start) return null;
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null;
  let startOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startNode && start < pos + len) {
      startNode = node;
      startOffset = start - pos;
    }
    if (end <= pos + len) {
      if (!startNode) return null;
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null; // offsets beyond the block's current text
}

let _pbpAskFlashTimer = null;
let _pbpAskFlashEl = null;

// Flash the jump target. Primary: CSS Custom Highlight API (zero DOM
// mutation). Fallback (no CSS.highlights): keyframed background class on
// the whole target element. Removal is clearTimeout-guarded so rapid
// consecutive clicks restart the 1600ms window instead of racing it.
function _pbpAskFlash(range, targetEl) {
  clearTimeout(_pbpAskFlashTimer);
  if (typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.set("pbp-flash", new Highlight(range));
    _pbpAskFlashTimer = setTimeout(() => { CSS.highlights.delete("pbp-flash"); }, 1600);
  } else {
    if (_pbpAskFlashEl) _pbpAskFlashEl.classList.remove("pb-flash-fallback");
    _pbpAskFlashEl = targetEl;
    void targetEl.offsetWidth; // restart the CSS animation
    targetEl.classList.add("pb-flash-fallback");
    _pbpAskFlashTimer = setTimeout(() => { targetEl.classList.remove("pb-flash-fallback"); _pbpAskFlashEl = null; }, 1600);
  }
}

// Chip click: scroll to the cited block (or its translation in
// translated-only view) and flash the verified quote span / whole block.
function _pbpAskJump(chip) {
  const p = Number(chip.dataset.p);
  const orig = pbpAiBlockEl(p);
  if (!orig) return;
  _pbpAskTipHide();
  let target = orig;
  // Three-view interplay: in translated-only view a filled original is
  // hidden (body.tr-only + [data-pb-tr-done]) -> jump to its .pb-tr
  // nextElementSibling instead. Bilingual view keeps originals visible,
  // so the precise quote span still applies there.
  if (document.body.classList.contains("tr-only") && orig.hasAttribute("data-pb-tr-done")) {
    const sib = orig.nextElementSibling;
    if (sib && sib.classList && sib.classList.contains("pb-tr")) target = sib;
  }
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  let range = null;
  // Verified offsets index the ORIGINAL block's textContent (translation
  // inserts siblings, never mutates the original's text nodes), so they
  // only apply when the original itself is the visible target.
  if (target === orig && chip.classList.contains("verified")) {
    range = _pbpAskRangeFromOffsets(orig, Number(chip.dataset.qs), Number(chip.dataset.qe));
  }
  if (!range) {
    range = document.createRange();
    range.selectNode(target);
  }
  _pbpAskFlash(range, target);
}

// ---- Single shared tooltip for all chips (lazy-created) ----
let _pbpAskTipEl = null;

function _pbpAskTipShow(chip) {
  if (!_pbpAskTipEl) {
    _pbpAskTipEl = document.createElement("div");
    _pbpAskTipEl.id = "ask-tip";
    _pbpAskTipEl.setAttribute("role", "tooltip");
    document.body.appendChild(_pbpAskTipEl);
    // Fixed positioning drifts on scroll; just hide (re-hover re-places it).
    window.addEventListener("scroll", _pbpAskTipHide, { capture: true, passive: true });
  }
  const tip = _pbpAskTipEl;
  tip.replaceChildren();
  const p = Number(chip.dataset.p);
  if (chip.dataset.quote) {
    const q = document.createElement("div");
    q.className = "ask-tip-quote";
    q.textContent = '"' + chip.dataset.quote + '"';
    tip.appendChild(q);
  }
  const blockText = pbpAiTextOf(p).replace(/\s+/g, " ").trim();
  const b = document.createElement("div");
  b.className = "ask-tip-block";
  b.textContent = "P" + p + " · " + blockText.slice(0, 80) + (blockText.length > 80 ? "…" : "");
  tip.appendChild(b);
  // Measure, then place above the chip; flip below when viewport space
  // above is too small. Clamp horizontally to the viewport.
  tip.style.visibility = "hidden";
  tip.style.display = "block";
  const cr = chip.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let top = cr.top - tr.height - 6;
  if (top < 8) top = cr.bottom + 6;
  let left = cr.left + cr.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  tip.style.top = top + "px";
  tip.style.left = left + "px";
  tip.style.visibility = "visible";
}

function _pbpAskTipHide() {
  if (_pbpAskTipEl) _pbpAskTipEl.style.display = "none";
}

// Stream-end finalizer, called by the Task 13 send path and the Task 15
// history restore. el = the .ask-a element that held streamed plain text.
// Returns {body, cites} so the caller can persist them with the record.
function _pbpAskFinalize(el, fullText) {
  const parsed = pbpAiParseCites(String(fullText == null ? "" : fullText));
  // renderMarkdown (md-convert.js) is the SINGLE sanitize point (marked +
  // DOMPurify); assigning its return via innerHTML is the established
  // md-preview.js pattern (renderedView.innerHTML = renderMarkdown(...),
  // md-preview.js ~line 330-333). NEVER assign raw model text to innerHTML.
  el.innerHTML = renderMarkdown(parsed.body);
  _pbpAskChipPass(el, parsed.cites);
  // Task 15 hook (copy button + history chrome). typeof-guarded so this
  // Task 14 commit stands alone before Task 15 lands.
  if (typeof _pbpAskDecorate === "function") _pbpAskDecorate(el, parsed);
  return parsed;
}

// ============================================================
// Ask history: restore + clear + per-answer copy (Task 15)
// ============================================================
// DOM contract (Task 12/13): panel #ask-panel, conversation container
// #ask-thread, question/answer elements .ask-q/.ask-a. Records persisted
// by the Task 13 send path as {q, a: full raw model text, cites, ts, model}
// via pbpAskHistSet (cap 20, md-ai-core).

// Static inline SVG (clipboard, same path set as the rail Copy buttons in
// md-preview.html). Constant string, never model text.
const PBP_ASK_COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

// Pure: compose the copied markdown = answer body + footnote block from
// the parsed cites. [^k] indexes follow cite order; quotes stay verbatim.
function _pbpAskBuildCopyText(body, cites) {
  const b = String(body == null ? "" : body).trim();
  const list = Array.isArray(cites) ? cites : [];
  if (!list.length) return b;
  const foot = list
    .map((c, i) => '[^' + (i + 1) + ']: "' + c.quote + '" — P' + c.p)
    .join("\n");
  return b + "\n\n" + foot;
}

function _pbpAskHistThread() {
  return document.getElementById("ask-thread");
}

// Hook called by _pbpAskFinalize (Task 14) for EVERY finalized answer --
// live-streamed and restored alike. Adds the per-answer copy button and
// makes sure the clear control exists once the thread has content.
function _pbpAskDecorate(el, parsed) {
  _pbpAskEnsureClear();
  if (el.querySelector(".ask-copy-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "action-btn ask-copy-btn";
  btn.innerHTML = PBP_ASK_COPY_SVG; // static inline SVG constant above
  const label = document.createElement("span");
  label.className = "btn-label";
  label.textContent = t("askCopyAnswer");
  btn.appendChild(label);
  const text = _pbpAskBuildCopyText(parsed.body, parsed.cites);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      flashButtonLabel(btn, t("askCopied"));
    } catch (_) {
      flashButtonLabel(btn, t("mdPreviewFailed"));
    }
  });
  el.appendChild(btn);
}

// ---- Clear: inline two-button confirm strip (never window.confirm) ----
function _pbpAskEnsureClear() {
  let btn = document.getElementById("ask-clear");
  const thread = _pbpAskHistThread();
  if (!btn) {
    if (!thread || !thread.parentNode) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ask-clear";
    btn.className = "ask-clear-btn";
    btn.textContent = t("askClear");
    thread.parentNode.insertBefore(btn, thread);
  }
  btn.hidden = false;
  if (!btn._pbpWired) {
    btn._pbpWired = true;
    btn.addEventListener("click", _pbpAskShowClearConfirm);
  }
}

function _pbpAskShowClearConfirm() {
  const thread = _pbpAskHistThread();
  if (!thread || document.getElementById("ask-clear-confirm")) return;
  // Markup produced here:
  // <div id="ask-clear-confirm" class="ask-clear-confirm" role="alertdialog"
  //      aria-label="{askClearConfirm}">
  //   <span class="ask-clear-msg">{askClearConfirm}</span>
  //   <button type="button" class="action-btn ask-clear-yes">{askClearYes}</button>
  //   <button type="button" class="action-btn ask-clear-no">{askClearNo}</button>
  // </div>
  const strip = document.createElement("div");
  strip.id = "ask-clear-confirm";
  strip.className = "ask-clear-confirm";
  strip.setAttribute("role", "alertdialog");
  strip.setAttribute("aria-label", t("askClearConfirm"));
  const msg = document.createElement("span");
  msg.className = "ask-clear-msg";
  msg.textContent = t("askClearConfirm");
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "action-btn ask-clear-yes";
  yes.textContent = t("askClearYes");
  const no = document.createElement("button");
  no.type = "button";
  no.className = "action-btn ask-clear-no";
  no.textContent = t("askClearNo");
  strip.appendChild(msg);
  strip.appendChild(yes);
  strip.appendChild(no);
  thread.parentNode.insertBefore(strip, thread);
  let cleared = false;
  yes.addEventListener("click", async () => {
    if (cleared) return;
    cleared = true;
    strip.remove();
    const clearBtn = document.getElementById("ask-clear");
    if (clearBtn) clearBtn.hidden = true;
    // Route through Task 12's clear path: it restores the empty-state hint
    // + starter chips AND erases ask_<url> — keeping ONE owner for the
    // post-clear panel state. Bare wipe only if the shell is absent.
    if (typeof _pbpAskClearThread === "function") {
      try { await _pbpAskClearThread(); } catch (_) {}
    } else {
      thread.replaceChildren();
      try { await pbpAskHistSet(_pbpAskHistUrl, []); } catch (_) {}
    }
  });
  no.addEventListener("click", () => strip.remove());
  no.focus(); // safe default: initial focus away from the destructive action
}

// ---- Restore persisted rounds when the (lazily mounted) thread appears ----
let _pbpAskHistUrl = "";
let _pbpAskHistRestored = false;

async function _pbpAskHistRestore() {
  const thread = _pbpAskHistThread();
  if (_pbpAskHistRestored || !thread || !_pbpAskHistUrl) return;
  _pbpAskHistRestored = true;
  let hist = [];
  try { hist = await pbpAskHistGet(_pbpAskHistUrl); } catch (_) {}
  if (!hist.length) return;
  // Restored rounds replace the empty-state hint; the starter chips
  // collapse (thread is no longer empty) — mirrors the live send path.
  const empty = document.getElementById("ask-empty");
  if (empty) empty.remove();
  const chips = document.getElementById("ask-chips");
  if (chips) chips.hidden = true;
  const frag = document.createDocumentFragment();
  const note = document.createElement("div");
  note.className = "ask-restored";
  note.textContent = t("askRestoredNote", String(hist.length));
  frag.appendChild(note);
  for (const rec of hist) {
    if (!rec || typeof rec.a !== "string") continue;
    const qEl = document.createElement("div");
    qEl.className = "ask-q";
    qEl.textContent = String(rec.q || "");
    const aEl = document.createElement("div");
    aEl.className = "ask-a";
    frag.appendChild(qEl);
    frag.appendChild(aEl);
    // SAME pipeline as live answers: pbpAiParseCites -> renderMarkdown
    // (single sanitize point) -> chip pass -> verification runs AGAIN
    // against the current block index -> decorate (copy button).
    _pbpAskFinalize(aEl, rec.a);
  }
  // Prepend: if a live round raced in before the async read finished,
  // restored history still reads in chronological order above it.
  thread.insertBefore(frag, thread.firstChild);
}

document.addEventListener("pbp:rendered", (e) => {
  _pbpAskHistUrl = (e.detail && e.detail.url) || "";
  pbpAiGetSettings().then((s) => {
    if (!pbpAiAvailable(s)) return; // master gate: zero residue when off
    if (_pbpAskHistThread()) { _pbpAskHistRestore(); return; }
    // The panel mounts lazily on first open (rail button, hotkey "a", or
    // the explain bridge). Watch for #ask-thread, restore once, disconnect.
    const mo = new MutationObserver(() => {
      if (!_pbpAskHistThread()) return;
      mo.disconnect();
      _pbpAskHistRestore();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }).catch(() => {});
}, { once: true });

// ============================================================
// Explain-selection (spec 5.3): selection observer + pill + popover.
// Trigger ladder lives in settings key selectionTrigger:
//   "icon" (default) -> pill next to the selection end + hotkey "e"
//   "hotkey"         -> no pill, hotkey "e" only
//   "off"            -> nothing registers at all
// ============================================================

// Pill geometry: 28px square, 6px gap from the selection rect, 8px viewport
// margin. Placed below-right of the selection end so it NEVER covers the
// selected line; flips above when the viewport bottom is too close.
function pbpExplainPillPos(rect, vw, vh) {
  const S = 28, GAP = 6, M = 8;
  let x = rect.right + GAP;
  if (x + S > vw - M) x = vw - M - S;
  if (x < M) x = M;
  let y = rect.bottom + GAP;
  let above = false;
  if (y + S > vh - M) { above = true; y = rect.top - GAP - S; }
  if (y < M) y = M;
  return { x, y, above };
}

// Minimum meaningful selection: >= 2 chars after trimming (spec 5.3).
function pbpExplainSelectionValid(text) {
  return typeof text === "string" && text.trim().length >= 2;
}

// ---- Explain: module state ----
let _pbpExplainPage = { url: "", title: "" };
let _pbpExplainSettings = null;
let _pbpExplainTrigger = "icon"; // live value; the in-popover gear updates it
let _pbpExplainMouseDown = false;
let _pbpExplainSelTimer = null;
let _pbpExplainPillEl = null;

// Static inline SVG (Feather help-circle). Constant string, never model text.
const PBP_EXPLAIN_PILL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Current selection if (and only if) it is explainable: non-collapsed, both
// endpoints inside #rendered-view, >= 2 chars. Returns { range, text } | null.
function _pbpExplainGetSelection() {
  const view = document.getElementById("rendered-view");
  if (!view) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!view.contains(range.startContainer) || !view.contains(range.endContainer)) return null;
  const text = sel.toString();
  if (!pbpExplainSelectionValid(text)) return null;
  return { range, text: text.trim() };
}

function _pbpExplainEnsurePill() {
  if (_pbpExplainPillEl) return _pbpExplainPillEl;
  const pill = document.createElement("button");
  pill.id = "explain-pill";
  pill.type = "button";
  pill.hidden = true;
  pill.title = t("explainSelection");
  pill.setAttribute("aria-label", t("explainSelection"));
  pill.innerHTML = PBP_EXPLAIN_PILL_SVG; // static constant, see above
  // Keep the selection alive through the click (mousedown would clear it).
  pill.addEventListener("mousedown", (e) => e.preventDefault());
  pill.addEventListener("click", () => pbpExplainInvoke());
  document.body.appendChild(pill);
  _pbpExplainPillEl = pill;
  return pill;
}

function _pbpExplainHidePill() {
  if (_pbpExplainPillEl) _pbpExplainPillEl.hidden = true;
}

function _pbpExplainShowPill() {
  if (_pbpExplainTrigger !== "icon") { _pbpExplainHidePill(); return; }
  const cap = _pbpExplainGetSelection();
  if (!cap) { _pbpExplainHidePill(); return; }
  const rect = cap.range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) { _pbpExplainHidePill(); return; }
  const pos = pbpExplainPillPos(rect, window.innerWidth, window.innerHeight);
  const pill = _pbpExplainEnsurePill();
  pill.style.left = pos.x + "px";
  pill.style.top = pos.y + "px";
  pill.hidden = false;
}

// Entry point for BOTH the pill click and the "e" hotkey. Captures the
// selection NOW (the popover's light-dismiss may clear it later) and hands
// off to the popover (Task 17). The typeof guard keeps this commit shippable
// before the popover lands: invoke is then a silent no-op.
function pbpExplainInvoke() {
  const cap = _pbpExplainGetSelection();
  if (!cap) return;
  _pbpExplainHidePill();
  if (typeof _pbpExplainOpenPop === "function") _pbpExplainOpenPop(cap);
}

function pbpExplainInit(detail) {
  _pbpExplainPage = { url: (detail && detail.url) || "", title: (detail && detail.title) || "" };
  pbpAiGetSettings().then((s) => {
    if (!pbpAiAvailable(s)) return; // gate: master switch + key (spec rule 1/2)
    _pbpExplainSettings = s;
    _pbpExplainTrigger = s.selectionTrigger || "icon";
    if (_pbpExplainTrigger === "off") return; // "off": zero listeners, zero DOM

    // Mouse selection: suppress UI while dragging; read the selection 10ms
    // after mouseup (the browser settles the final range after the event).
    document.addEventListener("mousedown", (e) => {
      if (_pbpExplainPillEl && _pbpExplainPillEl.contains(e.target)) return;
      _pbpExplainMouseDown = true;
      _pbpExplainHidePill();
    });
    document.addEventListener("mouseup", () => {
      setTimeout(() => { _pbpExplainMouseDown = false; _pbpExplainShowPill(); }, 10);
    });
    // Keyboard selection (Shift+arrows): 100ms debounce; skipped while the
    // mouse is down (mouseup owns that path).
    document.addEventListener("selectionchange", () => {
      if (_pbpExplainMouseDown) return;
      clearTimeout(_pbpExplainSelTimer);
      _pbpExplainSelTimer = setTimeout(_pbpExplainShowPill, 100);
    });
    // Fixed-position pill drifts on scroll: just hide it (re-select or "e").
    window.addEventListener("scroll", _pbpExplainHidePill, { passive: true });
    // Hotkey "e": works in both "icon" and "hotkey" modes. Guarded like the
    // ask panel's "a": no modifiers, not in editable targets. Coexists with
    // the "a"/Esc keydown handler above — different keys entirely.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "e" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (_pbpExplainTrigger === "off") return;
      if (!_pbpExplainGetSelection()) return;
      e.preventDefault();
      pbpExplainInvoke();
    });
  });
}

document.addEventListener("pbp:rendered", (e) => pbpExplainInit((e && e.detail) || {}));
