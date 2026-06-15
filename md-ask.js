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
