// ============================================================
// Pinboard Bookmark Enhanced - AI & Content Extraction (shared)
// ============================================================

// ---- Page content extraction (used by popup and background) ----
// Callback-wrapped chrome APIs: when tab closes mid-call, promise form leaks
// "Unchecked runtime.lastError: No tab with id" via the legacy lastError channel
// that await/try-catch cannot consume. Callback form lets us read lastError
// inside the callback — the only Chromium-guaranteed consumption path.
function _cbTabsGet(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      void chrome.runtime.lastError; resolve(tab || null);
    });
  });
}
function _cbExecuteScript(args) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(args, (results) => {
      void chrome.runtime.lastError; resolve(results || null);
    });
  });
}

async function getPageInfoFromTab(tabId, opts = {}) {
  // Defuddle is a ~120KB content extractor injected into the target tab. It's only needed
  // for AI summary/tags + batch save with AI enabled — NOT for filling the popup form
  // (which only needs url/title/selectedText/metaDescription). Default off saves 50-200ms
  // per popup open for users not invoking AI right away. AI/batch paths pass {withDefuddle: true}.
  const withDefuddle = !!opts.withDefuddle;
  try {
    const tab = await _cbTabsGet(tabId);
    if (!tab) return null;
    const url = tab.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
      return { url, title: tab.title || "", selectedText: "", metaDescription: "", referrer: "", pageText: "" };
    }

    if (withDefuddle) {
      // Inject Defuddle library first (ignore failure — e.g. tab closed mid-inject)
      await _cbExecuteScript({ target: { tabId }, files: ["vendor/defuddle.js"] });
    }

    const results = await _cbExecuteScript({
      target: { tabId },
      args: [withDefuddle],
      func: (useDefuddle) => {
        const info = { url: location.href, title: document.title, selectedText: "", metaDescription: "", referrer: document.referrer || "", pageText: "" };
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) { const t = sel.toString().trim(); if (t) info.selectedText = t; }
        const md = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
        if (md) info.metaDescription = md.getAttribute("content") || "";

        // Fast path (default): no pageText extraction. Popup form only needs the fields above.
        if (!useDefuddle) return info;

        // Try Defuddle for high-quality content extraction
        if (typeof Defuddle !== "undefined") {
          // Patch window.URL in the ISOLATED world to prevent defuddle from
          // throwing "Failed to construct 'URL': Invalid URL" on relative/weird hrefs
          // (GitHub releases pages etc.). Mirrors popup.js extractLocalMarkdown shim.
          // Without this, throws still get reported in chrome://extensions Errors panel
          // even when our window.error listener "swallows" them post-throw.
          const OriginalURL = window.URL;
          if (!window.__pp_urlShimInstalled) {
            const SafeURL = function(u, b) {
              try { return b !== undefined ? new OriginalURL(u, b) : new OriginalURL(u); }
              catch (_) { return new OriginalURL("about:blank"); }
            };
            SafeURL.prototype = OriginalURL.prototype;
            try { SafeURL.createObjectURL = OriginalURL.createObjectURL.bind(OriginalURL); } catch (_) {}
            try { SafeURL.revokeObjectURL = OriginalURL.revokeObjectURL.bind(OriginalURL); } catch (_) {}
            try { SafeURL.canParse = OriginalURL.canParse && OriginalURL.canParse.bind(OriginalURL); } catch (_) {}
            window.URL = SafeURL;
            window.__pp_urlShimInstalled = true;
          }
          // Belt-and-suspenders: still swallow async errors that escape try/catch
          // (YouTube/Reddit __awaiter promises reject AFTER parse() returns).
          const swallowDefuddle = (ev) => {
            try {
              const reason = ev && ev.reason;
              const msg = String((ev && ev.message) || (reason && reason.message) || reason || "");
              const stack = String((ev && ev.error && ev.error.stack) || (reason && reason.stack) || "");
              const filename = String((ev && ev.filename) || "");
              const isURLError = /Failed to construct 'URL'|Invalid URL|URL constructor/i.test(msg + " " + stack);
              const fromDefuddle = /defuddle/i.test(filename) || /defuddle/i.test(stack);
              if (isURLError || fromDefuddle) {
                ev.preventDefault && ev.preventDefault();
                ev.stopImmediatePropagation && ev.stopImmediatePropagation();
                ev.stopPropagation && ev.stopPropagation();
                return false;
              }
            } catch (_) { /* never let the swallow handler itself throw */ }
          };
          window.addEventListener("error", swallowDefuddle, true);
          window.addEventListener("unhandledrejection", swallowDefuddle, true);
          // Extend window to 3s — YouTube extractor's fetchPlayerData + pollFor
          // (setTimeout 250ms × up to 20 tries) can run up to ~5s, but 3s covers
          // the common failure path on non-YouTube pages where the async URL
          // throws early. Cleanup prevents listener leakage on long sessions.
          setTimeout(() => {
            window.removeEventListener("error", swallowDefuddle, true);
            window.removeEventListener("unhandledrejection", swallowDefuddle, true);
          }, 3000);
          try {
            const clone = document.cloneNode(true);
            // Suppress Defuddle's internal console.error for malformed schema.org JSON on third-party pages
            const _origCE = console.error;
            console.error = (...a) => { if (!String(a[0]).startsWith("Defuddle:")) _origCE.apply(console, a); };
            let result;
            try { result = new Defuddle(clone).parse(); } finally { console.error = _origCE; }
            if (result?.textContent && result.textContent.length > 50) {
              info.pageText = result.textContent.substring(0, 8000);
              return info;
            }
          } catch (_) { /* fall through to legacy */ }
        }

        // Fallback: legacy innerText extraction
        const mainEl = document.querySelector("article") || document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
        info.pageText = (mainEl ? mainEl.innerText : "").substring(0, 8000);
        return info;
      }
    });
    if (results?.[0]?.result) return results[0].result;
  } catch (e) { console.warn("getPageInfoFromTab failed:", e.message); }
  return null;
}


// ---- Fetch with timeout ----
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---- Unified AI error handler ----
async function handleAIError(res, provider) {
  let msg = `${provider} failed (HTTP ${res.status})`;
  let errorType = null;
  try {
    const body = await res.json();
    if (body.error?.message) msg = `${provider}: ${body.error.message}`;
    else if (body.error?.type) msg = `${provider}: ${body.error.type}`;
    // Detect model-not-found errors: 404, or message/type contains model-related keywords
    const combined = String(msg + (body.error?.type || "")).toLowerCase();
    if (res.status === 404 || /model|not.*exist|not.*found|unknown.*model/i.test(combined)) {
      errorType = "model_not_found";
    }
  } catch (_) {}
  const err = new Error(msg);
  if (errorType) err.code = errorType;
  throw err;
}

// ---- OpenAI-compatible provider registry ----
// Single source of truth for every provider reached via callOpenAICompat /
// _streamOpenAICompat. gemini / claude / ollama use bespoke callers (different
// request/response shapes) and are dispatched ahead of this table.
//   keyField     settings key holding the API key (also drives hasAIKey)
//   base         default endpoint (overridable per-provider via baseField)
//   baseField    optional settings key whose value overrides `base` (openai/custom)
//   modelField   settings key holding the model id
//   defaultModel fallback when the model setting is blank
const OPENAI_COMPAT_PROVIDERS = {
  openai:      { keyField: "openaiApiKey",      base: "https://api.openai.com/v1",                         baseField: "openaiBaseUrl", modelField: "openaiModel",      defaultModel: "gpt-5.4-nano" },
  deepseek:    { keyField: "deepseekApiKey",    base: "https://api.deepseek.com/v1",                                            modelField: "deepseekModel",    defaultModel: "deepseek-v4-flash" },
  qwen:        { keyField: "qwenApiKey",        base: "https://dashscope.aliyuncs.com/compatible-mode/v1",                      modelField: "qwenModel",        defaultModel: "qwen3.5-flash" },
  minimax:     { keyField: "minimaxApiKey",     base: "https://api.minimaxi.com/v1",                                            modelField: "minimaxModel",     defaultModel: "MiniMax-M2.7" },
  openrouter:  { keyField: "openrouterApiKey",  base: "https://openrouter.ai/api/v1",                                           modelField: "openrouterModel",  defaultModel: "meta-llama/llama-4-scout:free" },
  groq:        { keyField: "groqApiKey",        base: "https://api.groq.com/openai/v1",                                         modelField: "groqModel",        defaultModel: "llama-3.1-8b-instant" },
  mistral:     { keyField: "mistralApiKey",     base: "https://api.mistral.ai/v1",                                              modelField: "mistralModel",     defaultModel: "mistral-small-latest" },
  cohere:      { keyField: "cohereApiKey",      base: "https://api.cohere.ai/compatibility/v1",                                              modelField: "cohereModel",      defaultModel: "command-r7b-12-2024" },
  siliconflow: { keyField: "siliconflowApiKey", base: "https://api.siliconflow.cn/v1",                                          modelField: "siliconflowModel", defaultModel: "Qwen/Qwen3-8B" },
  zhipu:       { keyField: "zhipuApiKey",       base: "https://open.bigmodel.cn/api/paas/v4",                                   modelField: "zhipuModel",       defaultModel: "glm-4.7-flash" },
  kimi:        { keyField: "kimiApiKey",        base: "https://api.moonshot.cn/v1",                                             modelField: "kimiModel",        defaultModel: "kimi-k2.6" },
  custom:      { keyField: "customApiKey",      base: "",                                                  baseField: "customBaseUrl", modelField: "customModel",      defaultModel: "" },
};

// Resolve an OpenAI-compatible provider's base URL (per-provider baseField override wins).
function _openaiCompatBase(cfg, s) {
  return (cfg.baseField && s[cfg.baseField]) || cfg.base;
}

// ---- Check if AI key is configured ----
function hasAIKey(s) {
  const p = s.aiProvider || "gemini";
  if (p === "ollama") return true;
  const keyField = p === "gemini" ? "geminiApiKey"
    : p === "claude" ? "claudeApiKey"
    : OPENAI_COMPAT_PROVIDERS[p] && OPENAI_COMPAT_PROVIDERS[p].keyField;
  return !!(keyField && s[keyField]);
}

// ---- Host-permission gate for user-configured endpoints ----
// Three providers can target an origin that is NOT in the static host_permissions:
// "custom" (any base URL), "openai" (a base-URL override, e.g. Azure/a proxy), and
// "ollama" (a non-loopback/remote URL). Fetching such an origin without a host grant
// is subject to CORS and usually fails — and the background quick-save path runs in a
// Service Worker, which has no user gesture to request the permission itself. Resolve
// the origin a call will hit so we can verify the grant up front and fail with an
// actionable message instead of a cryptic CORS error. Returns an origin match pattern
// ("https://host/*"), or null when no runtime grant is needed (the built-in static
// hosts, or loopback Ollama which is reached via its own permissive CORS).
function _aiTargetOriginPattern(s) {
  const p = (s && s.aiProvider) || "gemini";
  let base;
  if (p === "custom") base = s.customBaseUrl;
  else if (p === "openai") base = s.openaiBaseUrl || "https://api.openai.com/v1";
  else if (p === "ollama") base = s.ollamaBaseUrl || "http://localhost:11434";
  else return null;
  try {
    const u = new URL(base);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return null;
    return u.origin + "/*";
  } catch (_) {
    return null; // malformed/empty URL — let the request fail with its own error
  }
}

// Throw an actionable error when the configured endpoint's origin is not granted.
// Read-only: chrome.permissions.contains needs no user gesture and works in the SW.
// No-op outside an extension context (e.g. unit-test pages) and for static providers.
// The narrow origin is a subset of the declared optional *://*/* permission, which is
// how the options-page Test button requests it on a real gesture.
async function _ensureAIHostPermission(s) {
  const pattern = _aiTargetOriginPattern(s);
  if (!pattern) return;
  if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.contains) return;
  let has = true;
  try {
    has = await chrome.permissions.contains({ origins: [pattern] });
  } catch (_) {
    return; // contains itself failed — don't block; let the fetch attempt run
  }
  if (!has) {
    const err = new Error(t("aiErrorHostPermission", pattern.replace(/\/\*$/, "")));
    err.code = "host_permission";
    throw err;
  }
}

// ---- AI dispatcher ----
async function callAI(s, prompt, opts = {}) {
  await _ensureAIHostPermission(s);
  const p = s.aiProvider || "gemini";
  if (p === "gemini") return callGemini(s, prompt, opts);
  if (p === "claude") return callClaude(s, prompt, opts);
  if (p === "ollama") return callOllama(s, prompt, opts);
  const cfg = OPENAI_COMPAT_PROVIDERS[p];
  if (!cfg) throw new Error("Unknown provider: " + p);
  return callOpenAICompat(_openaiCompatBase(cfg, s), s[cfg.keyField], s[cfg.modelField] || cfg.defaultModel, prompt, opts);
}

async function callGemini(s, prompt, opts = {}) {
  const model = s.geminiModel || "gemini-2.5-flash-lite";
  const maxTokens = opts.maxTokens || 1024;
  // Gemini API requires key as URL param (no Authorization header support) — API design limitation
  const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${s.geminiApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens } })
  });
  if (!res.ok) await handleAIError(res, "Gemini");
  const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function callClaude(s, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 1024;
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": s.claudeApiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: s.claudeModel || "claude-haiku-4-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) await handleAIError(res, "Claude");
  const text = (await res.json()).content?.[0]?.text?.trim();
  if (!text) throw new Error("Claude returned empty response");
  return text;
}

async function callOpenAICompat(baseUrl, apiKey, model, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 1024;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: maxTokens })
  });
  if (!res.ok) await handleAIError(res, "API");
  const text = (await res.json()).choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("API returned empty response");
  return text;
}

async function callOllama(s, prompt, opts = {}) {
  const base = (s.ollamaBaseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const res = await fetchWithTimeout(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: s.ollamaModel || "llama3.2", messages: [{ role: "user", content: prompt }], stream: false })
  });
  if (!res.ok) await handleAIError(res, "Ollama");
  const text = (await res.json()).message?.content?.trim();
  if (!text) throw new Error("Ollama returned empty response");
  return text;
}

// ============================================================
// Streaming helpers (md-preview ask / translate / explain)
// ============================================================
// Pure SSE/NDJSON parsing. No fetch, no chrome.*, no DOM — unit-tested
// in tests/md-ai-tests.html.

// Split complete SSE events out of an accumulating text buffer.
// Returns { events, rest }: `events` = the "data:" payload of every
// COMPLETE event (blank-line terminated; multiple data lines joined with
// \n per SSE spec; comment/event:/id: lines dropped); `rest` = trailing
// incomplete fragment the caller must keep and prepend to the next chunk.
function _pbpSseChunks(buffered) {
  const blocks = String(buffered).split(/\r?\n\r?\n/);
  const rest = blocks.pop();
  const events = [];
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length) {
      const payload = dataLines.join("\n");
      if (payload) events.push(payload);
    }
  }
  return { events, rest };
}

// Per-provider delta extractors: parsed JSON chunk -> visible text or null.
// null = chunk carries no user-visible text (role headers, pings, usage,
// thinking deltas, final stats) — the caller simply skips it.
function _pbpOpenAIDelta(obj) {
  const t = obj?.choices?.[0]?.delta?.content;
  return (typeof t === "string" && t.length) ? t : null;
}

function _pbpGeminiDelta(obj) {
  const parts = obj?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  let out = "";
  for (const p of parts) { if (typeof p?.text === "string") out += p.text; }
  return out.length ? out : null;
}

function _pbpClaudeDelta(obj) {
  if (obj?.type !== "content_block_delta") return null;
  const t = obj.delta?.text;
  return (typeof t === "string" && t.length) ? t : null;
}

function _pbpOllamaDelta(obj) {
  const t = obj?.message?.content;
  return (typeof t === "string" && t.length) ? t : null;
}

// ---- Stream plumbing ----

const PBP_STREAM_IDLE_MS = 30000;

// Child AbortController that follows the caller's optional signal.
// The 30s idle timeout aborts the CHILD only — never the caller's
// controller (callers reuse one controller across parallel requests,
// e.g. the translate queue's Stop button).
function _pbpChainAbort(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

// Shared streaming driver. POSTs `url` and pipes the response body
// through `consume(buf, isFinal) -> rest`: consume extracts complete
// payloads from the accumulated text and returns the unconsumed tail
// (must return "" when isFinal).
// Idle timeout: one resettable 30s timer, armed before fetch and re-armed
// on every received network chunk — covers time-to-first-byte AND
// mid-stream stalls. (Byte-level, not delta-level: an SSE keep-alive
// comment also resets it, which is the desired liveness semantics.)
// Rejections: handleAIError(res, providerName) on non-ok; DOMException
// AbortError when the CALLER aborts; Error("AI stream timeout") when the
// idle timer fires.
async function _pbpStreamRead(url, init, opts, providerName, consume) {
  const ctrl = _pbpChainAbort(opts.signal);
  let timedOut = false;
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, PBP_STREAM_IDLE_MS);
  };
  let reader = null;
  try {
    resetIdle();
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    // Headers received: start a fresh idle window for time-to-first-byte.
    resetIdle();
    if (!res.ok) {
      clearTimeout(idleTimer);
      // always throws (same semantics as the non-streaming callers)
      await handleAIError(res, providerName);
    }
    if (!res.body) {
      clearTimeout(idleTimer);
      throw new Error(providerName + " response has no stream body");
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });
      buf = consume(buf, false);
    }
    buf += decoder.decode();
    consume(buf, true);
  } catch (e) {
    // Caller abort takes precedence over an idle timeout that fired in the
    // same tick, so the rejection surfaces as the caller's AbortError, not
    // "AI stream timeout".
    if (timedOut && !(opts.signal && opts.signal.aborted)) {
      throw new Error("AI stream timeout");
    }
    throw e;
  } finally {
    clearTimeout(idleTimer);
    if (reader) { try { reader.cancel(); } catch (_) {} }
  }
}

// Build a consume() for SSE bodies: split complete events, JSON-parse each,
// run the provider delta extractor, forward text via onText(delta).
// "[DONE]" (OpenAI terminator) and unparseable keep-alives are skipped;
// stream end is signaled by the reader, not by the terminator.
function _pbpSseConsumer(extractDelta, onText) {
  return (buf, isFinal) => {
    const { events, rest } = _pbpSseChunks(isFinal ? buf + "\n\n" : buf);
    for (const ev of events) {
      if (ev === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(ev); } catch (_) { continue; }
      const d = extractDelta(obj);
      if (d) onText(d);
    }
    return isFinal ? "" : rest;
  };
}

async function _streamOpenAICompat(baseUrl, apiKey, model, prompt, opts, onDelta) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  let full = "";
  await _pbpStreamRead(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST", headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
        max_tokens: opts.maxTokens || 1024,
        stream: true
      })
    },
    opts, "API",
    _pbpSseConsumer(_pbpOpenAIDelta, (d) => { full += d; onDelta(d, full); })
  );
  if (!full.trim()) throw new Error("API returned empty response");
  return full;
}

async function _streamGemini(s, prompt, opts, onDelta) {
  const model = opts.model || s.geminiModel || "gemini-2.5-flash-lite";
  const generationConfig = {
    temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
    maxOutputTokens: opts.maxTokens || 1024
  };
  // Translate path: hard-disable thinking so the output budget is all payload.
  if (opts.noThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  let full = "";
  // Gemini requires the key as a URL param (same limitation as callGemini)
  await _pbpStreamRead(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${s.geminiApiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    opts, "Gemini",
    _pbpSseConsumer(_pbpGeminiDelta, (d) => { full += d; onDelta(d, full); })
  );
  if (!full.trim()) throw new Error("Gemini returned empty response");
  return full;
}

async function _streamClaude(s, prompt, opts, onDelta) {
  const body = {
    model: opts.model || s.claudeModel || "claude-haiku-4-5",
    max_tokens: opts.maxTokens || 1024,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
    messages: [{ role: "user", content: prompt }],
    stream: true
  };
  if (opts.system) body.system = opts.system;
  let full = "";
  await _pbpStreamRead(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.claudeApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    },
    opts, "Claude",
    _pbpSseConsumer(_pbpClaudeDelta, (d) => { full += d; onDelta(d, full); })
  );
  if (!full.trim()) throw new Error("Claude returned empty response");
  return full;
}

async function _streamOllama(s, prompt, opts, onDelta) {
  const base = (s.ollamaBaseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const body = {
    model: opts.model || s.ollamaModel || "llama3.2",
    messages,
    stream: true,
    options: {
      temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
      num_predict: opts.maxTokens || 1024
    }
  };
  let full = "";
  // Ollama streams NDJSON (one JSON object per line), not SSE.
  const consume = (buf, isFinal) => {
    const lines = buf.split("\n");
    const rest = isFinal ? "" : lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch (_) { continue; }
      const d = _pbpOllamaDelta(obj);
      if (d) { full += d; onDelta(d, full); }
    }
    return rest;
  };
  await _pbpStreamRead(
    `${base}/api/chat`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    opts, "Ollama", consume
  );
  if (!full.trim()) throw new Error("Ollama returned empty response");
  return full;
}

// ---- Streaming AI dispatcher ----
// callAIStream(s, prompt, opts, onDelta) -> Promise<string fullText>
//   opts: { maxTokens?, model? (override provider default), system?,
//           signal? (AbortSignal), temperature? (default 0.3),
//           noThinking? (Gemini only) }
//   onDelta(deltaText, accumulatedText) fires once per text chunk.
//   Resolves with the full accumulated text (identical to the last
//   accumulatedText passed to onDelta). Rejects with handleAIError
//   semantics on non-ok / AbortError on caller abort /
//   Error("AI stream timeout") on 30s idle.
async function callAIStream(s, prompt, opts = {}, onDelta) {
  const cb = (typeof onDelta === "function") ? onDelta : () => {};
  await _ensureAIHostPermission(s);
  const p = s.aiProvider || "gemini";
  if (p === "gemini") return _streamGemini(s, prompt, opts, cb);
  if (p === "claude") return _streamClaude(s, prompt, opts, cb);
  if (p === "ollama") return _streamOllama(s, prompt, opts, cb);
  const cfg = OPENAI_COMPAT_PROVIDERS[p];
  if (!cfg) throw new Error("Unknown provider: " + p);
  const model = opts.model || s[cfg.modelField] || cfg.defaultModel;
  return _streamOpenAICompat(_openaiCompatBase(cfg, s), s[cfg.keyField], model, prompt, opts, cb);
}

// ---- Shared prompt fragments (used by tag, summary, and combined builders) ----
const TAG_SEP_MAP = {
  "-": "use hyphens for multi-word (e.g. machine-learning)",
  "_": "use underscores for multi-word (e.g. machine_learning)",
  " ": "use spaces for multi-word tags",
};

function aiTagLangInstruction(s) {
  const lang = (s && s.aiTagLang) || "en";
  if (lang === "auto") return "Use the same language as the content for tags.";
  if (lang === "zh") return "Tags must be in Chinese (简体中文).";
  if (lang === "zh-TW") return "Tags must be in Traditional Chinese (繁體中文/台灣).";
  if (lang === "zh-HK") return "Tags must be in Traditional Chinese (繁體中文/香港).";
  if (lang === "en") return "Tags must be in English.";
  if (lang === "ja") return "Tags must be in Japanese (日本語).";
  if (lang === "ko") return "Tags must be in Korean (한국어).";
  return `Tags must be in ${lang}.`;
}

function aiSummaryLangInstruction(s) {
  const lang = (s && s.aiSummaryLang) || "auto";
  if (lang === "zh") return "Write in Chinese (简体中文).";
  if (lang === "zh-TW") return "Write in Traditional Chinese (繁體中文/台灣).";
  if (lang === "zh-HK") return "Write in Traditional Chinese (繁體中文/香港).";
  if (lang === "en") return "Write in English.";
  if (lang === "ja") return "Write in Japanese.";
  if (lang === "ko") return "Write in Korean.";
  if (lang !== "auto") return `Write in ${lang}.`;
  return "Write in the same language as the content.";
}

// ---- Prompt builders (no DOM dependency) ----
function buildTagPrompt(s, title, url, content, description, userTags) {
  const sep = s.aiTagSeparator || "-";
  const tmpl = s.customTagPrompt?.trim() || DEFAULT_TAG_PROMPT;
  let prompt = tmpl
    .replace(/\{\{lang_instruction\}\}/g, () => aiTagLangInstruction(s))
    .replace(/\{\{separator_instruction\}\}/g, () => TAG_SEP_MAP[sep] || TAG_SEP_MAP["-"])
    .replace(/\{\{title\}\}/g, () => title || "")
    .replace(/\{\{url\}\}/g, () => url || "")
    .replace(/\{\{content\}\}/g, () => (content || "").substring(0, 4000))
    .replace(/\{\{description\}\}/g, () => description || "");
  if (userTags && userTags.length > 0) {
    prompt += `\n\nExisting tags (prefer reusing these if applicable): ${userTags.slice(0, 50).join(", ")}`;
  }
  return prompt;
}

function buildSummaryPrompt(s, title, url, content, description) {
  const tmpl = s.customSummaryPrompt?.trim() || DEFAULT_SUMMARY_PROMPT;
  return tmpl
    .replace(/\{\{title\}\}/g, () => title || "")
    .replace(/\{\{url\}\}/g, () => url || "")
    .replace(/\{\{content\}\}/g, () => (content || "").substring(0, 4000))
    .replace(/\{\{description\}\}/g, () => description || "")
    .replace(/\{\{lang_instruction\}\}/g, () => aiSummaryLangInstruction(s));
}

function buildCombinedPrompt(s, title, url, content, description, userTags) {
  const sep = s.aiTagSeparator || "-";
  let prompt = `Analyze the following webpage and return ONLY a JSON object with exactly two keys: "summary" and "tags".

"summary": ${aiSummaryLangInstruction(s)} Summarize concisely in 2-4 sentences, focusing on key points.

"tags": an array of up to ${AI_TAG_CAP} bookmark tags. ${aiTagLangInstruction(s)} Tags should be lowercase, ${TAG_SEP_MAP[sep] || TAG_SEP_MAP["-"]}.
${TAG_GUIDANCE}

Title: {{title}}
URL: {{url}}
Content: {{content}}

Format: {"summary":"...","tags":["tag1","tag2"]}`;
  prompt = prompt
    .replace(/\{\{title\}\}/g, () => title || "")
    .replace(/\{\{url\}\}/g, () => url || "")
    .replace(/\{\{content\}\}/g, () => (content || "").substring(0, 4000));
  if (userTags && userTags.length > 0) {
    prompt += `\n\nExisting tags (prefer reusing these if applicable): ${userTags.slice(0, 50).join(", ")}`;
  }
  return prompt;
}

// Parse a combined {"summary","tags"} reply. Throws on no-object / bad-JSON /
// empty result so callers can fall back to two separate calls.
function parseAICombined(resp, separator) {
  const sep = separator || "-";
  if (typeof resp !== "string") throw new Error("combined: empty response");
  const m = resp.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("combined: no JSON object");
  const obj = JSON.parse(m[0]); // throws on bad JSON -> caller falls back
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  let tags = Array.isArray(obj.tags) ? obj.tags : [];
  tags = tags.filter(t => typeof t === "string").map(t => t.toLowerCase().replace(/\s+/g, sep));
  tags = refineTags(tags, { cap: AI_TAG_CAP, separator: sep });
  if (!summary && tags.length === 0) throw new Error("combined: empty result");
  return { summary, tags };
}

// ---- Parse AI tag response ----
// separator: "-" or "_" (configurable via settings.aiTagSeparator)
function parseAITags(resp, separator) {
  const sep = separator || "-";
  let tags = [];
  try {
    const m = resp.match(/\[[\s\S]*?\]/);
    if (m) tags = JSON.parse(m[0]);
  } catch (_) {
    tags = resp.split(/[,\n]/).map(t => t.replace(/["[\]`]/g, "").trim()).filter(Boolean);
  }
  return tags.map(t => t.toLowerCase().replace(/\s+/g, sep));
}

// ---- Refine AI tags: dedup, conservative plural fold, preserve order, cap ----
// Input is the already-normalized output of parseAITags (lowercased, separator-applied),
// but the helper is defensive so it can also be fed raw model strings.
function refineTags(tags, opts) {
  const cap = (opts && opts.cap) || AI_TAG_CAP;
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag) continue;
    // Canonical key: lowercase, strip separators/spaces so "token-relay" == "token_relay" == "tokenrelay".
    const key = tag.toLowerCase().replace(/[\s_-]+/g, "");
    if (!key || seen.has(key)) continue;
    // Conservative English plural fold: an ASCII word ending in "s" whose singular was already kept.
    if (/^[a-z0-9][a-z0-9_\- ]*s$/.test(tag.toLowerCase()) && seen.has(key.slice(0, -1))) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= cap) break;
  }
  return out;
}

// ---- In-flight dedup registry ----
// Prevents duplicate paid API calls when auto-click and manual click race
// (e.g. popup boot auto-clicks ai-tags-btn while user clicks it too).
// Mirrors the _pendingChecks pattern in background.js.
const _inflightAI = new Map(); // key -> Promise

function getOrCreateInflight(key, factory) {
  if (_inflightAI.has(key)) return _inflightAI.get(key);
  const promise = factory();
  _inflightAI.set(key, promise);
  promise.finally(() => _inflightAI.delete(key));
  return promise;
}

// ---- AI cache helpers ----
function getCacheKey(url, type, source) { return `ai_cache_${type}_${source || "local"}_${url}`; }


async function getAICache(url, type, cacheDuration, source) {
  const key = getCacheKey(url, type, source);
  const dur = resolveCacheMs(cacheDuration);
  if (dur === 0) return null;   // 0 now reachable: cache disabled, never read

  // IDB path (sole AI-cache backend)
  if (typeof pbpAiCacheGet !== "function") return null;
  const entry = await pbpAiCacheGet(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > dur) {
    pbpAiCacheDelete(key).catch(() => {});
    return null;
  }
  return entry.result;
}

async function setAICache(url, type, result, cacheDuration, source) {
  if (resolveCacheMs(cacheDuration) === 0) return;   // disabled: never write
  const key = getCacheKey(url, type, source);
  const timestamp = Date.now();

  // IDB path (sole AI-cache backend)
  if (typeof pbpAiCacheSet !== "function") return;
  await pbpAiCacheSet(key, result, timestamp);
}

// ---- Build notes/description for a page ----
function buildAutoNotes(pageInfo, opts) {
  let desc = "";
  if (pageInfo.selectedText) {
    desc = opts.blockquote ? `<blockquote>${escapeForExtended(pageInfo.selectedText)}</blockquote>` : pageInfo.selectedText;
  } else if (opts.autoDescription && pageInfo.metaDescription) {
    desc = pageInfo.metaDescription;
  }
  if (opts.includeReferrer && pageInfo.referrer) {
    desc += (desc ? "\n\n" : "") + `via: ${pageInfo.referrer}`;
  }
  return desc;
}
