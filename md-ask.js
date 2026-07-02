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
  // #ask-thread now exists in the live document — restore history straight
  // away instead of polling for it via MutationObserver (audit #28).
  // _pbpAskHistRestore is idempotent (_pbpAskHistRestored guard) and a no-op
  // until the "pbp:rendered" listener below has set _pbpAskHistUrl, which by
  // construction (this function is only reachable through wiring pbpAskInit
  // adds AFTER that same event) has already run by the time a user can open
  // the panel.
  _pbpAskHistRestore().catch(() => {});

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
  // Enter sends, Shift+Enter inserts a newline (spec 5.1). IME guard
  // first: Chrome dispatches a key="Enter" keydown with isComposing=true
  // (keyCode 229 as a fallback signal) when the user confirms an IME
  // candidate - that Enter must never submit the still-uncommitted
  // composition text.
  panel.querySelector("#ask-input").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
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
  if (open) {
    // Remember who opened us so we can hand focus back on close (non-modal,
    // so this is focus-RETURN only, not a trap). Skip if focus is already
    // inside the panel (e.g. re-open while open).
    const ae = document.activeElement;
    if (ae && ae !== document.body && !panel.contains(ae)) _pbpAskState.opener = ae;
  }
  document.body.classList.toggle("ask-open", open);
  panel.hidden = !open;
  const btn = document.getElementById("ask-open");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // Transparency-line seam: implemented by the send-flow task.
    if (typeof _pbpAskUpdateMeta === "function") _pbpAskUpdateMeta();
    const ta = document.getElementById("ask-input");
    if (ta) ta.focus();
  } else {
    const op = _pbpAskState.opener;
    if (op && typeof op.focus === "function" && document.contains(op)) op.focus();
    _pbpAskState.opener = null;
  }
}

// Clear: wipe the visible thread, restore starter chips + empty hint,
// and erase the persisted ask_<url> history.
async function _pbpAskClearThread() {
  // Wipe the in-memory conversation FIRST: st.rounds feeds every future
  // prompt (_pbpAskRun/_pbpAskUpdateMeta), and aborting any in-flight
  // request sends it down the AbortError branch of _pbpAskRun's catch -
  // which never pushes to st.rounds or ask history - so a stream that
  // was mid-flight when the user clicked Clear can't silently "revive"
  // the wiped conversation once it finishes.
  if (_pbpAskState) {
    _pbpAskState.rounds = [];
    if (_pbpAskState.ctrl) _pbpAskState.ctrl.abort();
  }
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
// Hard per-block char cap applied before a line enters the budget calc
// (naming mirrors PBP_EXPLAIN_BLOCK_CAP below): a single abnormally huge
// block (e.g. a full-page <pre> log dump) must not alone blow the whole
// context budget.
const PBP_ASK_BLOCK_CAP = 8000;

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
    String((b.el && b.el.textContent) || "").slice(0, PBP_ASK_BLOCK_CAP).replace(/\s+/g, " ").trim();
  // Largest k whose evenly-spaced sample of `items` (chars taken from the
  // matching index of `lens`, plus a fixed `offsetChars`) fits within
  // `budgetTokens`. Shared by the mandatory-downgrade branch and the
  // middle-sampling pass below: same "largest count that fits" rule,
  // applied to whichever candidate list/budget needs it.
  const sampleFit = (items, lens, offsetChars, budgetTokens2) => {
    for (let k = items.length; k >= 1; k--) {
      let chars = offsetChars;
      const idxs = [];
      for (let j = 0; j < k; j++) {
        const ix = Math.floor(j * items.length / k);
        idxs.push(ix);
        chars += lens[ix];
      }
      if (pbpAiEstimateTokens(chars) <= budgetTokens2) return idxs;
    }
    return [];
  };
  const mandatory = [];
  const middle = [];
  list.forEach((b, i) => {
    const must = b.tag === "h2" || b.tag === "h3" || b.tag === "h4"
      || i < 3 || i >= totalBlocks - 2;
    (must ? mandatory : middle).push(b);
  });
  const mandLens = mandatory.map((b) => lineOf(b).length + 1);
  let baseChars = 0;
  for (const len of mandLens) baseChars += len;
  let picked;
  if (pbpAiEstimateTokens(baseChars) > budget) {
    // mandatory alone (headings + first 3 + last 2) already overflows
    // the WHOLE budget - e.g. a page-long <pre> sits among the first 3
    // blocks. Degrade it with the same sampling rule middle uses below;
    // no room is left for middle in this branch.
    picked = new Set(sampleFit(mandatory, mandLens, 0, budget).map((ix) => mandatory[ix].n));
  } else {
    picked = new Set(mandatory.map((b) => b.n));
    const midLens = middle.map((b) => lineOf(b).length + 1);
    for (const ix of sampleFit(middle, midLens, baseChars, budget)) picked.add(middle[ix].n);
  }
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
  // #ask-thread is aria-live=polite; without aria-busy, every rAF-throttled
  // textContent replace during streaming re-announces the whole accumulated
  // answer (audit md-ask.js:140). Mirrors the Explain popover's aria-busy
  // pattern (_pbpExplainRun, .xp-body).
  aEl.setAttribute("aria-busy", "true");
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
    // Guard BEFORE touching the DOM: _pbpAskRun silently no-ops while another
    // question is running (line ~478 `if (!st || st.running) return;`). Without
    // this check, clicking Retry on Q1's failed answer while Q2 streams wipes
    // Q1's error UI + adds .streaming shimmer, but the request never fires --
    // a permanent empty "streaming" bubble (audit md-ask.js:423).
    if (_pbpAskState && _pbpAskState.running) return;
    aEl.replaceChildren();
    aEl.classList.add("streaming");
    aEl.setAttribute("aria-busy", "true");
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
    aEl.removeAttribute("aria-busy");
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
    aEl.removeAttribute("aria-busy");
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
        // verified vs not is currently only a color dot (::after) -- invisible
        // to SR/color-blind users, who can't tell "jumps to the exact quote"
        // apart from "jumps to the whole block" (audit md-preview.css:829).
        chip.setAttribute("aria-label", "P" + seg.p + " · " + t("askChipVerified"));
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
  if (chip.classList.contains("verified")) {
    const v = document.createElement("div");
    v.className = "ask-tip-status";
    v.textContent = t("askChipVerified");
    tip.appendChild(v);
  }
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
  // Perf (audit #27): finalize (renderMarkdown + fuzzy chip verification,
  // md-ai-core.js's bounded Levenshtein scan on exact-miss) is spread across
  // rAF frames instead of one synchronous pass over up to 20 records, so a
  // long history doesn't stall the panel's first open. The whole fragment
  // still lands in the DOM with a single insertBefore once every record is
  // built, preserving the "live round races in" ordering guarantee below.
  const raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  const PBP_ASK_HIST_CHUNK = 2;
  let hi = 0;
  await new Promise((resolve) => {
    const step = () => {
      const end = Math.min(hi + PBP_ASK_HIST_CHUNK, hist.length);
      for (; hi < end; hi++) {
        const rec = hist[hi];
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
        const parsed = _pbpAskFinalize(aEl, rec.a);
        // Seed st.rounds with the restored Q&A too, not just the DOM: it is
        // what pbpAskBuildPrompt/_pbpAskUpdateMeta read (_pbpAskRun), so a
        // follow-up question after a page reload still carries PREVIOUS
        // Q&A context - same {q, a: <parsed body>} shape _pbpAskRun pushes
        // for a live answer (md-ask.js:466).
        if (_pbpAskState) {
          _pbpAskState.rounds = _pbpAskState.rounds || [];
          _pbpAskState.rounds.push({ q: String(rec.q || ""), a: parsed.body });
        }
      }
      if (hi < hist.length) raf(step); else resolve();
    };
    raf(step);
  });
  // Prepend: if a live round raced in before the async build finished,
  // restored history still reads in chronological order above it.
  thread.insertBefore(frag, thread.firstChild);
}

// Just remember the URL for _pbpAskHistRestore. Restore itself now fires
// from _pbpAskBuildPanel right after #ask-thread mounts (audit #28) — no
// need to watch document.body for the panel's lazy first open, which used
// to leave a MutationObserver running for the rest of the session on any
// page where AI is configured but the user never opens the panel.
document.addEventListener("pbp:rendered", (e) => {
  _pbpAskHistUrl = (e.detail && e.detail.url) || "";
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

// Persist the explain trigger to the same area options.js writes (sync when
// optSyncEnabled, else local). A sync-area write can reject on quota/throttle;
// the in-memory _pbpExplainTrigger already took effect, so swallow it rather
// than surface an unhandled rejection from the radio change handler.
async function _pbpExplainPersistTrigger(value) {
  try {
    await (await pbpAiSettingsArea()).set({ selectionTrigger: value });
  } catch (_) { /* quota/throttle: in-memory switch already applied */ }
}

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
  clearTimeout(_pbpExplainSelTimer);
  _pbpExplainSelTimer = null;
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
  if (cap.range) cap.rect = cap.range.getBoundingClientRect();
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
      if (!_pbpExplainGetSelection()) return;
      e.preventDefault();
      pbpExplainInvoke();
    });
  }).catch(() => {});
}

document.addEventListener("pbp:rendered", (e) => pbpExplainInit((e && e.detail) || {}), { once: true });

// ===========================================================================
// Task 17: explain popover — length routing / sentence scan / context pack /
// streamed answer into an HTML Popover. Appended after Task 16's pill/hotkey.
// ===========================================================================

// ---- Explain: length routing (spec 5.3) ----
// <=4 whitespace-separated words -> define-in-context; CJK selections carry
// no spaces, so a spaceless run containing CJK counts as a term up to 8
// chars; a spaceless non-CJK run is one word, hence always a term.
function pbpExplainIsTerm(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return false;
  if (/\s/.test(s)) return s.split(/\s+/).length <= 4;
  // Han + Kana (inside U+2E80-U+9FFF) / Hangul / CJK Compatibility Ideographs
  if (/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(s)) return s.length <= 8;
  return true;
}

// ---- Explain: sentence-boundary scan around [start, end) ----
// Backward from start to the previous boundary (exclusive), forward from end
// through the next boundary (inclusive). Boundaries: . ! ? ; newline and
// their CJK forms. No boundary found -> text edge. Result is trimmed.
function pbpExplainSentenceAround(text, start, end) {
  const s = String(text == null ? "" : text);
  const n = s.length;
  const a = Math.max(0, Math.min(Number(start) || 0, n));
  const b = Math.max(a, Math.min(Number(end) || 0, n));
  const isBoundary = (c) => ".!?;\n".indexOf(c) !== -1 || "。！？；".indexOf(c) !== -1;
  let from = 0;
  for (let i = a - 1; i >= 0; i--) {
    if (isBoundary(s[i])) { from = i + 1; break; }
  }
  let to = n;
  for (let i = b; i < n; i++) {
    if (isBoundary(s[i])) { to = i + 1; break; }
  }
  return s.slice(from, to).trim();
}

// ---- Explain: answer language = the READER's UI language ----
// Maps uiLangToBCP47() (md-preview.js) output to a human language name for
// the prompt. The 9 supported UI locales; anything else answers in English.
const PBP_EXPLAIN_LANG_NAMES = {
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  "ja": "Japanese",
  "ko": "Korean",
  "en": "English",
  "de": "German",
  "fr": "French",
  "pl": "Polish",
  "ru": "Russian"
};
function pbpExplainLangName(bcp47) {
  return PBP_EXPLAIN_LANG_NAMES[bcp47] || "English";
}

// ---- Explain: prompt builder (pure) ----
function pbpExplainBuildPrompt(p) {
  const isTerm = !!p.isTerm;
  const system = "You are a precise reading assistant embedded in an article viewer. " +
    "Answer in " + p.answerLang + ". Use the article context to disambiguate meaning. " +
    "Output plain markdown prose only: no headings, no preamble, no restating the question. " +
    (isTerm
      ? "Define the selected term as it is used in THIS article in 2-4 sentences, then add one sentence on why it matters here."
      : "Explain the selected passage in 3-6 sentences: what it says and what it implies in this article's argument.");
  const parts = [];
  parts.push("Article title: " + (p.title || "(untitled)"));
  if (p.prevText) parts.push("Previous paragraph:\n" + p.prevText);
  parts.push("Paragraph containing the selection:\n" + p.blockText);
  if (p.nextText) parts.push("Next paragraph:\n" + p.nextText);
  parts.push("Full sentence containing the selection:\n" + p.sentence);
  parts.push((isTerm ? "Selected term: " : "Selected passage: ") + '"' + p.selection + '"');
  return { system, prompt: parts.join("\n\n") };
}

// ---- Explain: popover shell (lazy-mounted on first invoke) ----
let _pbpExplainPopEl = null;
let _pbpExplainAbort = null;

// Static inline SVG (Feather settings gear). Constant string, never model text.
const PBP_EXPLAIN_GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

// Footer transparency label: "<provider> · <model>" — override wins, else the
// provider's configured model key (e.g. s.geminiModel), else provider alone.
function _pbpExplainModelLabel(s) {
  const p = s.aiProvider || "gemini";
  const m = pbpAiResolveModelOverride(s) || (typeof s[p + "Model"] === "string" ? s[p + "Model"] : "");
  return m ? p + " · " + m : p;
}

// Bridge into the ask panel: close the popover, open the panel, prefill the
// question box with the quoted selection, focus it. Prefers the ask
// section's opener when exposed; otherwise drives the contract-fixed shell
// (#ask-panel + body.ask-open) directly.
function _pbpExplainOpenAsk(selText) {
  const prefill = '"' + selText + '" ';
  if (typeof window.pbpAskOpenPanel === "function") {
    window.pbpAskOpenPanel(prefill);
    return;
  }
  const panel = document.getElementById("ask-panel");
  if (!panel) return;
  document.body.classList.add("ask-open");
  const input = panel.querySelector("textarea");
  if (input) {
    input.value = prefill;
    input.focus();
  }
}

function _pbpExplainEnsurePop() {
  if (_pbpExplainPopEl) return _pbpExplainPopEl;
  const pop = document.createElement("div");
  pop.id = "explain-pop";
  pop.setAttribute("popover", "auto"); // top-layer + Esc + light-dismiss for free
  const head = document.createElement("div");
  head.className = "xp-head";
  const term = document.createElement("span");
  term.className = "xp-term";
  head.appendChild(term);
  const body = document.createElement("div");
  body.className = "xp-body";
  const foot = document.createElement("div");
  foot.className = "xp-foot";
  const model = document.createElement("span");
  model.className = "xp-model";
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "xp-ask";
  ask.textContent = t("explainAskMore");
  ask.addEventListener("click", () => {
    const selText = pop.querySelector(".xp-term").textContent;
    try { pop.hidePopover(); } catch (_) {}
    _pbpExplainOpenAsk(selText);
  });
  const gearWrap = document.createElement("span");
  gearWrap.className = "xp-gear-wrap";
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "xp-gear";
  gear.title = t("explainSettings");
  gear.setAttribute("aria-label", t("explainSettings"));
  gear.setAttribute("aria-expanded", "false");
  gear.innerHTML = PBP_EXPLAIN_GEAR_SVG; // static constant, see above
  const menu = document.createElement("div");
  menu.className = "xp-gear-menu";
  menu.hidden = true;
  [["icon", t("explainTriggerIcon")], ["hotkey", t("explainTriggerHotkey")], ["off", t("explainTriggerOff")]]
    .forEach(([value, label]) => {
      const lab = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "xp-trigger";
      radio.value = value;
      radio.addEventListener("change", () => {
        // On-the-spot trigger-ladder switch (spec 5.3), persisted to the
        // SAME storage area options.js writes (sync when optSyncEnabled,
        // else local). Takes effect immediately via the live module var.
        _pbpExplainTrigger = value;
        if (value !== "icon") _pbpExplainHidePill();
        _pbpExplainPersistTrigger(value);   // fire-and-forget; never rejects
      });
      lab.appendChild(radio);
      lab.appendChild(document.createTextNode(" " + label));
      menu.appendChild(lab);
    });
  gear.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this same click trigger the outside-close below
    menu.hidden = !menu.hidden;
    gear.setAttribute("aria-expanded", String(!menu.hidden));
  });
  // Click anywhere outside the gear (but still inside the popover) closes the
  // menu; a click outside the popover light-dismisses the whole popover.
  pop.addEventListener("click", (e) => {
    if (!menu.hidden && !gearWrap.contains(e.target)) {
      menu.hidden = true;
      gear.setAttribute("aria-expanded", "false");
    }
  });
  gearWrap.appendChild(gear);
  gearWrap.appendChild(menu);
  foot.appendChild(model);
  foot.appendChild(ask);
  foot.appendChild(gearWrap);
  pop.appendChild(head);
  pop.appendChild(body);
  pop.appendChild(foot);
  // Light dismiss / Esc: abort any in-flight stream when the popover closes,
  // and reset the gear menu so it reopens closed (the popover element is reused).
  pop.addEventListener("toggle", (e) => {
    if (e.newState === "closed") {
      if (_pbpExplainAbort) _pbpExplainAbort.abort();
      menu.hidden = true;
      gear.setAttribute("aria-expanded", "false");
    }
  });
  document.body.appendChild(pop);
  _pbpExplainPopEl = pop;
  return pop;
}

// ---- Explain: context pack ----
// Selection + full sentence + host block + one neighbor each side + title.
// Caps keep the request bounded (output is the budget at 1024 tokens; input
// stays comfortably small). Works on translated sibling blocks too (.pb-tr
// is inserted by md-translate as the original block's nextSibling): the
// original block text is sent alongside, labeled, per spec 5.3.
const PBP_EXPLAIN_BLOCK_CAP = 4000;
const PBP_EXPLAIN_NEIGHBOR_CAP = 1200;

function _pbpExplainPackContext(cap) {
  const view = document.getElementById("rendered-view");
  // Ask/translate init owns the canonical pbpAiIndexBlocks call on
  // pbp:rendered; this is only a lazy backfill (re-indexing resets caches).
  if (view && !pbpAiBlocks().length) pbpAiIndexBlocks(view);
  let node = cap.range.startContainer;
  if (node && node.nodeType !== 1) node = node.parentElement;
  const blockEl = node ? node.closest("[data-pb], .pb-tr, #rendered-view > *") : null;
  let n = 0;
  let trText = "";
  if (blockEl && blockEl.dataset.pb) {
    n = Number(blockEl.dataset.pb);
  } else if (blockEl && blockEl.classList.contains("pb-tr")
      && blockEl.previousElementSibling && blockEl.previousElementSibling.dataset.pb) {
    n = Number(blockEl.previousElementSibling.dataset.pb);
    trText = blockEl.textContent || "";
  }
  const origText = n ? pbpAiTextOf(n) : ((blockEl && blockEl.textContent) || cap.text);
  // The sentence is scanned in the text the selection actually lives in
  // (the translated block when selecting inside .pb-tr).
  const hostText = trText || origText;
  const idx = hostText.indexOf(cap.text);
  const sentence = idx === -1
    ? cap.text
    : pbpExplainSentenceAround(hostText, idx, idx + cap.text.length);
  let blockText = origText.slice(0, PBP_EXPLAIN_BLOCK_CAP);
  if (trText) {
    blockText += "\n\nTranslated rendering of the same paragraph (the selection comes from this translation):\n"
      + trText.slice(0, PBP_EXPLAIN_BLOCK_CAP);
  }
  const prevText = n > 1 ? pbpAiTextOf(n - 1).slice(0, PBP_EXPLAIN_NEIGHBOR_CAP) : "";
  const nextText = (n && pbpAiBlockEl(n + 1)) ? pbpAiTextOf(n + 1).slice(0, PBP_EXPLAIN_NEIGHBOR_CAP) : "";
  return { sentence, blockText, prevText, nextText };
}

// ---- Explain: streamed request into the popover body ----
async function _pbpExplainRun(cap, ctx, pop) {
  const s = _pbpExplainSettings || await pbpAiGetSettings();
  const body = pop.querySelector(".xp-body");
  // Skeleton: 3 shimmer lines + an SR-only loading announcement.
  body.setAttribute("aria-busy", "true");
  body.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement("div");
    sk.className = "xp-skel";
    body.appendChild(sk);
  }
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = t("explainLoading");
  body.appendChild(sr);
  // A new invocation aborts the previous in-flight request — this is also
  // the double-click guard (no inflight dedup needed: the old stream dies).
  if (_pbpExplainAbort) _pbpExplainAbort.abort();
  const ctrl = new AbortController();
  _pbpExplainAbort = ctrl;
  const { system, prompt } = pbpExplainBuildPrompt({
    selection: cap.text,
    sentence: ctx.sentence,
    blockText: ctx.blockText,
    prevText: ctx.prevText,
    nextText: ctx.nextText,
    title: _pbpExplainPage.title || document.title,
    answerLang: pbpExplainLangName(uiLangToBCP47()),
    isTerm: pbpExplainIsTerm(cap.text)
  });
  pbpAiBumpCounter("explain"); // local usage counter, storage.local only
  const stream = document.createElement("div");
  stream.className = "xp-stream";
  let started = false;
  let pending = "";
  let rafId = 0;
  const flush = () => { rafId = 0; stream.textContent = pending; };
  try {
    // temperature intentionally omitted: callAIStream defaults to 0.3 (the
    // existing ask/explain default). maxTokens 1024 per spec 5.3.
    const full = await callAIStream(s, prompt, {
      maxTokens: 1024,
      model: pbpAiResolveModelOverride(s),
      system,
      signal: ctrl.signal
    }, (delta, acc) => {
      if (!started) { started = true; body.replaceChildren(stream); }
      pending = acc; // markers can split across chunks: always render the accumulated text
      if (!rafId) rafId = requestAnimationFrame(flush); // rAF-throttled DOM writes
    });
    if (rafId) cancelAnimationFrame(rafId);
    // Final pass through the single sanitize point (renderMarkdown =
    // marked + DOMPurify, md-convert.js). Never innerHTML raw model text.
    const md = document.createElement("div");
    md.className = "xp-md";
    md.innerHTML = renderMarkdown(full);
    body.replaceChildren(md);
  } catch (e) {
    if (rafId) cancelAnimationFrame(rafId);
    if (e && e.name === "AbortError") return; // closed or re-invoked: silent
    const wrap = document.createElement("div");
    wrap.className = "xp-error";
    const msg = document.createElement("p");
    msg.textContent = (e && e.message) || "Request failed"; // handleAIError text, plain
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "xp-retry";
    retry.textContent = t("explainErrRetry");
    retry.addEventListener("click", () => _pbpExplainRun(cap, ctx, pop));
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    body.replaceChildren(wrap);
  } finally {
    body.removeAttribute("aria-busy");
  }
}

// ---- Explain: open (called by pbpExplainInvoke, Task 16) ----
// Everything needed is captured at invoke time: cap.rect is a FROZEN DOMRect
// snapshot taken by pbpExplainInvoke before this runs, so positioning never
// touches the live range. The block lookup below reads cap.range.startContainer
// synchronously (before any await) — light dismiss only collapses the range
// after this turn, so the DOM node is still valid here (spec 5.3).
function _pbpExplainOpenPop(cap) {
  const pop = _pbpExplainEnsurePop();
  pop.querySelector(".xp-term").textContent = cap.text; // ellipsized via CSS
  pop.querySelector(".xp-model").textContent = _pbpExplainModelLabel(_pbpExplainSettings || {});
  // Gear radios mirror the live trigger value; menu starts closed.
  const menu = pop.querySelector(".xp-gear-menu");
  menu.hidden = true;
  pop.querySelector(".xp-gear").setAttribute("aria-expanded", "false");
  menu.querySelectorAll('input[type="radio"]').forEach((r) => {
    r.checked = (r.value === _pbpExplainTrigger);
  });
  // Pack context first (reads the live DOM node synchronously), then show.
  const ctx = _pbpExplainPackContext(cap);
  const rect = cap.rect || cap.range.getBoundingClientRect(); // frozen snapshot
  try { pop.hidePopover(); } catch (_) {} // re-invoke while open: reset first
  pop.showPopover();
  // Anchor near the selection: measure after showPopover, clamp to viewport,
  // flip above when the bottom is too close.
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const x = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - pw - 8));
  let y = rect.bottom + 8;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, rect.top - ph - 8);
  pop.style.left = x + "px";
  pop.style.top = y + "px";
  _pbpExplainRun(cap, ctx, pop);
}
