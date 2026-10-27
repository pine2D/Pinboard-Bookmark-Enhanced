#!/usr/bin/env node
// Explicitly authorized live dictionary checks. Default --plan reads only the
// public provider configuration. Real credentials remain in the Node process;
// Chromium receives a dummy key and production scripts, never the real key.
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(REPO, ".qa-scan/report/dict-live");
const CONFIG = resolve(homedir(), ".config/ai-dev");
const SCOPE = "dictionary-four-provider-2026-10-25";
const DUMMY_KEY = "dict-live-nonsecret-browser-placeholder";
// The usage-point cases follow the 2026-10-27 redesign (plan 1B.9): the old
// collocations-with-topic step became the patterns card and the separate
// confusables request. The plan hash changes with them, so no ledger or
// approval of the earlier case list can be continued under this one.
const CASES = ["entry", "patterns", "confusables"];
const DEFINITIONS = {
  deepseek: { prefix: "DEEPSEEK", provider: "deepseek", keyField: "deepseekApiKey", modelField: "deepseekModel", model: "deepseek-flash", currency: "USD", cap: .10, input: .30, output: 1.20, priceSource: "https://api-docs.deepseek.com/quick_start/pricing/" },
  minimax: { prefix: "MINIMAX", provider: "minimax", keyField: "minimaxApiKey", modelField: "minimaxModel", model: "MiniMax-M3.1-Flash", currency: "CNY", cap: .30, input: 1, output: 4, priceSource: "https://platform.minimax.cn/docs/pricing/overview" },
  gemini: { prefix: "GEMINI", provider: "custom", keyField: "customApiKey", modelField: "customModel", model: "gemini-3.8-flash", currency: "USD", cap: .25, input: .75, output: 3.75, priceSource: "https://ai.google.dev/gemini-api/docs/pricing" },
  openrouter: { prefix: "OPENROUTER", provider: "openrouter", keyField: "openrouterApiKey", modelField: "openrouterModel", model: "openai/gpt-6.1-sol", currency: "USD", cap: .60, input: 2, output: 10, priceSource: "https://openrouter.ai/openai/gpt-6.1-sol" }
};
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function buildPlan(publicText) {
  const fields = parseEnv(publicText), providers = {};
  for (const [id, def] of Object.entries(DEFINITIONS)) {
    const raw = fields[def.prefix + "_BASE_URL"], model = fields[def.prefix + "_MODEL"];
    if (!raw || !model) fail("public_config_missing_" + def.prefix);
    let url; try { url = new URL(raw); } catch { fail("public_endpoint_invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("public_endpoint_invalid");
    if (model !== def.model) fail("public_model_changed_" + def.prefix);
    providers[id] = { baseUrl: url.href.replace(/\/+$/, ""), model, keyVariable: def.prefix + "_API_KEY",
      productionProvider: def.provider, currency: def.currency, maximumCost: def.cap,
      pricePerMillionInput: def.input, pricePerMillionOutput: def.output,
      priceVerifiedAt: "2026-10-25", priceSource: def.priceSource };
  }
  const plan = { schema: 1, scope: SCOPE, providers, cases: CASES,
    data: { term: "provider", sourceLanguage: "en", explanationLanguage: "zh-Hans", nativeLanguage: "简体中文", level: "intermediate" },
    limits: { requestsPerProvider: 4, requestsPerCase: 2, inputUtf8Bytes: 24576, framingTokenAllowance: 1024,
      entryOutputTokens: 3072, supplementOutputTokens: 2048, diagnosticOutputTokens: 8192, transportRetries: 0, responseBytes: 262144,
      streamBodyBytes: STREAM_BODY_BYTES, timeoutMs: 28000 },
    boundaries: { inheritedProviderEnvironment: "ignored; file fields are authoritative", secrets: "only the authorized Node test process reads selected .env keys",
      gemini: "production custom provider, OpenAI-compatible protocol only; does not test the native Gemini adapter",
      endpoints: "isolated browser registry base override from providers.env; product files unchanged",
      optionalEvidence: "not granted; production entry skips optional Wiktionary retrieval; no literature/source-fetch coverage",
      paidPath: "production prompt -> callAIStream (stream:true, SSE) -> parser -> IndexedDB archive -> reread -> production entry mount and visible meanings/supplements",
      account: "synthetic Pinboard owner in an isolated profile; Drive disconnected; no user account or browser profile",
      retryAccounting: "production dialect fallback is counted; bridge never retries; case/provider caps persist across restarts",
      money: "conservative input-byte/output-token reservations; provider billing and current prices remain external assumptions",
      responseSize: "raw 2xx SSE body <= streamBodyBytes (about one token per event over the product's 8192-token stream budget); decoded answer and reasoning text, any non-stream body and any HTTP error body <= responseBytes",
      openrouterCostDifference: { provider: { max_price: { prompt: 2, completion: 10, request: 0 } } },
      openrouterCostSource: "https://openrouter.ai/docs/guides/routing/provider-selection#max-price" } };
  return { ...plan, planHash: digest(plan) };
}

export function validateApproval(plan, approval) {
  if (!approval || approval.authorized !== true || approval.planHash !== plan.planHash ||
      typeof approval.authorizationReference !== "string" || !approval.authorizationReference.trim() ||
      !Array.isArray(approval.providers) || !approval.providers.length || new Set(approval.providers).size !== approval.providers.length ||
      approval.providers.some(id => !own(plan.providers, id)) ||
      !Array.isArray(approval.cases) || !approval.cases.length || new Set(approval.cases).size !== approval.cases.length ||
      approval.cases.some(id => !CASES.includes(id)) ||
      ![false, true].includes(approval.retryFailed) ||
      ![null, 8192].includes(approval.diagnosticOutputTokens) ||
      ![undefined, false, true].includes(approval.minimaxLowFollowup)) fail("approval_required_or_mismatched");
  if (approval.minimaxLowFollowup && (approval.providers.length !== 1 || approval.providers[0] !== "minimax" ||
      approval.cases.length !== 1 || approval.cases[0] !== "patterns" || !approval.retryFailed ||
      approval.diagnosticOutputTokens !== null)) fail("followup_approval_invalid");
  return approval;
}

// A separate, explicit approval can add exactly one low-effort MiniMax check
// to the exhausted original ledger. It cannot reset that ledger or its money cap.
// It targets the patterns card, the supplement case that replaced collocations.
export function validateMinimaxLowFollowup(plan, ledger, approval) {
  validateApproval(plan, approval); validateLedger(plan, ledger);
  if (approval.minimaxLowFollowup !== true) fail("followup_approval_invalid");
  const row = ledger.providers.minimax, attempts = row.attempts;
  if (attempts.length !== 4 || attempts.filter(item => item.caseId === "patterns").length !== 2 ||
      attempts.some(item => item.authorizationScope === "minimax-low-followup") ||
      row.cases.entry?.ok !== true || row.cases.patterns?.ok !== false ||
      !attempts.some(item => item.caseId === "patterns" && item.httpStatus === 200 &&
        item.finishReason === "length" && item.contentEmpty === true)) fail("followup_ledger_ineligible");
  return true;
}

// Fixed public prices authorize only the UTC day on which they were checked.
// A later live run needs reviewed prices, a new scope and new approval; never
// roll an old ledger into a newly dated budget. Offline modes remain replayable.
export function validatePriceFreshness(plan, now = Date.now()) {
  let today;
  try { if (Number.isFinite(now)) today = new Date(now).toISOString().slice(0, 10); } catch {}
  const providers = Object.values(plan?.providers || {});
  if (!today || plan?.scope !== "dictionary-four-provider-" + today || !providers.length ||
      providers.some(provider => provider?.priceVerifiedAt !== today)) fail("price_verification_expired");
  return true;
}

export function newLedger(plan) {
  return { schema: 1, scope: SCOPE, planHash: plan.planHash, providers: Object.fromEntries(Object.keys(plan.providers)
    .map(id => [id, { reservedMicros: 0, attempts: [], cases: {} }])) };
}
export function validateLedger(plan, ledger) {
  if (!ledger || ledger.schema !== 1 || ledger.scope !== SCOPE || ledger.planHash !== plan.planHash) fail("ledger_plan_mismatch");
  for (const id of Object.keys(plan.providers)) {
    const row = ledger.providers?.[id];
    if (!row || !Number.isSafeInteger(row.reservedMicros) || row.reservedMicros < 0 || !Array.isArray(row.attempts) || !row.cases ||
        row.attempts.some(a => !CASES.includes(a.caseId) || !Number.isSafeInteger(a.reservedMicros) || a.reservedMicros < 0) ||
        row.reservedMicros !== row.attempts.reduce((sum, a) => sum + a.reservedMicros, 0)) fail("ledger_invalid");
  }
  return ledger;
}

// Reserve before dispatch, never release a reservation on errors or crashes.
// Money is in each provider's currency; do not mix CNY with USD or assume FX.
export function reserveAttempt(plan, ledger, id, caseId, inputBytes, outputTokens, approval = null) {
  validateLedger(plan, ledger);
  const provider = plan.providers[id], limits = plan.limits, row = ledger.providers[id];
  if (!provider || !CASES.includes(caseId) || !Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > limits.inputUtf8Bytes ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > limits.diagnosticOutputTokens) fail("request_bounds");
  const followup = approval?.minimaxLowFollowup === true;
  if (followup) {
    validateMinimaxLowFollowup(plan, ledger, approval);
    if (id !== "minimax" || caseId !== "patterns" || outputTokens !== 2048) fail("followup_request_bounds");
  } else if (row.attempts.length >= limits.requestsPerProvider || row.attempts.filter(a => a.caseId === caseId).length >= limits.requestsPerCase) fail("request_budget_exhausted");
  const reservedMicros = Math.ceil((inputBytes + limits.framingTokenAllowance) * provider.pricePerMillionInput + outputTokens * provider.pricePerMillionOutput);
  if (followup && reservedMicros > 40000) fail("cost_budget_exhausted");
  if (row.reservedMicros + reservedMicros > Math.floor(provider.maximumCost * 1e6)) fail("cost_budget_exhausted");
  const attempt = { caseId, inputBytes, outputTokens, reservedMicros, state: "reserved", at: new Date().toISOString() };
  if (followup) attempt.authorizationScope = "minimax-low-followup";
  row.attempts.push(attempt); row.reservedMicros += reservedMicros;
  return attempt;
}

export function redactText(value, keys = []) {
  let text = String(value);
  for (const key of keys.filter(Boolean)) text = text.split(key).join("[REDACTED]");
  return text.replace(/\b(?:sk|sk-or-v1)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
}
export function completionMetadata(body) {
  const choice = body?.choices?.[0], message = choice?.message;
  const finishReason = ["stop", "length", "tool_calls", "content_filter", "function_call"].includes(choice?.finish_reason) ? choice.finish_reason : "other_or_missing";
  const usage = {}, integer = value => Number.isSafeInteger(value) && value >= 0;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"]) if (integer(body?.usage?.[key])) usage[key] = body.usage[key];
  for (const [parent, key] of [["completion_tokens_details", "reasoning_tokens"], ["prompt_tokens_details", "cached_tokens"]]) {
    if (integer(body?.usage?.[parent]?.[key])) usage[parent + "." + key] = body.usage[parent][key];
  }
  return { finishReason, usage, contentLength: typeof message?.content === "string" ? message.content.length : 0,
    contentEmpty: typeof message?.content !== "string" || !message.content.trim(),
    reasoningContentLength: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0 };
}
// Dictionary generation streams (plan 2.7). An OpenAI-compatible SSE body
// (chat.completion.chunk events) is folded into the completion shape that
// completionMetadata/completionReport read, so stream and non-stream answers
// are diagnosed alike. Comment lines, event/id/retry fields and [DONE] are
// framing; reasoning_content (or its alias reasoning, counted once per chunk)
// stays in memory only for its length, as the non-stream body does. An
// in-stream error member is noted as present, never with the provider's text.
// Returns null when there is no data event or one does not parse as JSON.
export function streamCompletion(text) {
  let content = "", reasoning = "", finish = null, usage, events = 0, error = false, sawContent = false;
  for (const block of String(text).replace(/\r\n?/g, "\n").split("\n\n")) {
    const lines = block.split("\n").filter(line => line.startsWith("data:"));
    if (!lines.length) continue;
    const data = lines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data === "[DONE]") continue;
    let chunk; try { chunk = JSON.parse(data); } catch { return null; }
    events++;
    if (!chunk || typeof chunk !== "object") return null;
    if (chunk.error) error = true;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
    if (typeof delta.content === "string") { content += delta.content; sawContent = true; }
    reasoning += typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
  }
  if (!events) return null;
  return { ...(error ? { error: { inStream: true } } : {}), choices: [{ finish_reason: finish,
    message: { role: "assistant", content: sawContent ? content : null, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
    ...(usage ? { usage } : {}) };
}
// The product streams, so a 2xx answer is an SSE body; anything else (an
// HTTP error) is read as JSON. The format decides the replayed content type.
export function readAnswerBody(text, ok, contentType = "") {
  const streamed = ok && (/^text\/event-stream\b/i.test(contentType) || /^\s*(?:data:|event:|:)/.test(text));
  let parsed = null;
  if (streamed) parsed = streamCompletion(text);
  else { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  return { streamed, parsed, contentType: streamed ? "text/event-stream" : "application/json" };
}
export function completionReport(body, keys = []) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" ? { ...completionMetadata(body), content: redactText(content, keys) } : null;
}

function writeJson(path, value) {
  const temporary = path + ".pending";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, path);
}
function acquireLock(path) {
  try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") fail("ledger_lock_failed");
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("ledger_lock_invalid");
    let alive = true; try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
    if (alive) fail("another_live_test_running");
    unlinkSync(path); writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  return () => { try { unlinkSync(path); } catch {} };
}
export async function boundedBody(response, maxBytes) {
  const reader = response.body?.getReader(); if (!reader) fail("response_body_missing");
  const parts = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > maxBytes) fail("response_too_large"); parts.push(value); }
    return Buffer.concat(parts).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

// Bridge size bounds (plan 2.7). responseBytes keeps bounding what it bounded
// when answers were one JSON body: an HTTP error body, a 2xx body that is not
// a stream, and the decoded answer text plus reasoning of a 2xx stream. The raw
// SSE body is much larger than that text: compatible endpoints send about one
// token per chat.completion.chunk event, and every event repeats id, object,
// created, model, system_fingerprint and logprobs (about 250 bytes; an
// OpenRouter reasoning event repeats its text in reasoning_details, near 450).
// STREAM_FRAME_BYTES bounds one such event, taken over the product's whole
// stream output budget (8192 estimated tokens, thinking and answer together;
// the product stops a longer stream and saves nothing, and this bound also
// covers thinking that a provider does not count in max_tokens), plus a fixed
// allowance for the role, keep-alive, final, usage and [DONE] events.
export const STREAM_OUTPUT_TOKENS = 8192, STREAM_FRAME_BYTES = 640, STREAM_FIXED_BYTES = 262144;
export const STREAM_BODY_BYTES = STREAM_OUTPUT_TOKENS * STREAM_FRAME_BYTES + STREAM_FIXED_BYTES;
const utf8Bytes = value => typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
// Reads one upstream answer for the bridge under those bounds: redacted,
// parsed, and with the content type the bridge replays.
export async function readBridgeAnswer(response, { responseBytes, streamBodyBytes }, keys = []) {
  if (!Number.isSafeInteger(responseBytes) || !Number.isSafeInteger(streamBodyBytes) || streamBodyBytes < responseBytes) fail("response_bounds_invalid");
  const text = redactText(await boundedBody(response, response.ok ? streamBodyBytes : responseBytes), keys);
  const answer = readAnswerBody(text, response.ok, response.headers.get("content-type") || "");
  const message = answer.parsed?.choices?.[0]?.message;
  const decoded = answer.streamed ? utf8Bytes(message?.content) + utf8Bytes(message?.reasoning_content) : utf8Bytes(text);
  if (decoded > responseBytes) fail("response_too_large");
  return { text, ...answer };
}

// The product's own generation request: the configured model, one user
// message, no tools. Generation streams (plan 2.7), so stream must be exactly
// true and stream_options absent (the product never asks for include_usage).
export function isProductRequest(body, model) {
  return !!body && typeof body === "object" && body.model === model && body.stream === true && !own(body, "stream_options") &&
    Array.isArray(body.messages) && body.messages.length === 1 && body.messages[0]?.role === "user" &&
    typeof body.messages[0].content === "string" && !body.tools && !body.tool_choice;
}

async function executeProvider(plan, approval, ledger, id, key, saveLedger, { reportDir = REPORT, dispatch = fetch } = {}) {
  const config = plan.providers[id], def = DEFINITIONS[id], row = ledger.providers[id];
  const { chromium } = createRequire(resolve(REPO, ".qa-scan/package.json"))("playwright");
  const profile = resolve(reportDir, "profiles", id); mkdirSync(profile, { recursive: true, mode: 0o700 });
  const environment = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "FONTCONFIG_FILE"].filter(name => typeof process.env[name] === "string").map(name => [name, process.env[name]]));
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: chromium.executablePath(), env: environment,
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"] });
  let activeCase = "", blockedReason = "";
  try {
    await context.route(/^https?:/, async route => {
      const request = route.request(); let attempt;
      try {
        if (!activeCase || request.method() !== "POST" || request.url() !== config.baseUrl + "/chat/completions") fail("unapproved_network_request");
        const body = request.postDataJSON();
        if (!isProductRequest(body, config.model)) fail("unexpected_production_request");
        const baseline = activeCase === "entry" ? plan.limits.entryOutputTokens : plan.limits.supplementOutputTokens;
        const tokenField = own(body, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
        if (body[tokenField] !== baseline || (own(body, "max_completion_tokens") && own(body, "max_tokens"))) fail("unexpected_output_budget");
        if (approval.minimaxLowFollowup && (body.reasoning_effort !== "low" || own(body, "thinking"))) fail("followup_request_bounds");
        if (approval.diagnosticOutputTokens !== null) body[tokenField] = approval.diagnosticOutputTokens;
        if (id === "openrouter") body.provider = structuredClone(plan.boundaries.openrouterCostDifference.provider);
        attempt = reserveAttempt(plan, ledger, id, activeCase, Buffer.byteLength(body.messages[0].content, "utf8"), body[tokenField], approval);
        saveLedger(); // Crash after this line consumes the reservation; never refund or reset it.
        const response = await dispatch(config.baseUrl + "/chat/completions", { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(plan.limits.timeoutMs) });
        attempt.httpStatus = response.status;
        const { text: safeBody, parsed, contentType } = await readBridgeAnswer(response, plan.limits, [key]);
        // Only successful synthetic-case answer text is retained for parser
        // diagnosis. Never persist reasoning, raw provider errors or headers.
        const answer = response.ok ? completionReport(parsed, [key]) : null;
        if (answer) {
          attempt.responseReport = id + "-" + activeCase + "-http-" + row.attempts.length + ".json";
          writeJson(resolve(reportDir, attempt.responseReport), { provider: id, caseId: activeCase, ...answer });
        }
        Object.assign(attempt, completionMetadata(parsed), { state: "received" }); saveLedger();
        await route.fulfill({ status: response.status, contentType, body: safeBody });
      } catch (error) {
        const known = ["request_bounds", "request_budget_exhausted", "cost_budget_exhausted", "unapproved_network_request", "unexpected_production_request", "unexpected_output_budget", "response_body_missing", "response_too_large", "response_bounds_invalid", "followup_approval_invalid", "followup_ledger_ineligible", "followup_request_bounds"];
        const code = known.includes(error?.safeCode) ? error.safeCode : error?.name === "TimeoutError" ? "transport_timeout" : "transport_or_harness_failed";
        if (activeCase) blockedReason = code;
        if (attempt) { attempt.state = "failed_or_uncertain"; attempt.failure = code; saveLedger(); }
        await route.abort().catch(() => {});
      }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    await worker.evaluate(async ({ def, config, dummy }) => {
      if (typeof primeSettings === "function") await primeSettings();
      await chrome.storage.local.set({ optSyncEnabled: false, syncApiKeys: false, optLang: "zh_CN", previewAiEnabled: true,
        pinboardToken: obfuscateKey("dict_live_fixture:nonsecret_synthetic_token"), _hlOwnerClaimDone: true,
        aiProvider: def.provider, [def.keyField]: obfuscateKey(dummy), [def.modelField]: config.model,
        customBaseUrl: config.baseUrl, dictDefaultView: "ai-saved", dictDefinitionLang: "" });
    }, { def, config, dummy: DUMMY_KEY });
    const page = await context.newPage();
    await page.goto("chrome-extension://" + new URL(worker.url()).hostname + "/library.html#vocab");
    await page.waitForFunction(() => typeof pbpDictEntryRun === "function" && typeof pbpDictSupplementRun === "function");
    await page.evaluate(({ config, def }) => {
      if (def.provider !== "custom") OPENAI_COMPAT_PROVIDERS[def.provider].base = config.baseUrl;
      chrome.permissions.contains = async ({ origins }) => origins.length === 1 && origins[0] === new URL(config.baseUrl).origin + "/*";
      chrome.permissions.request = async () => false;
    }, { config, def });
    const preflight = await page.evaluate(async () => {
      const owner = await pbpVocabCurrentOwner();
      const sync = await chrome.runtime.sendMessage({ type: "PBP_DICT_ARCHIVE_SYNC", owner });
      return { ownerMatches: owner === "acct_dict_live_fixture", syncOk: sync?.ok === true, connected: sync?.connected === true };
    });
    if (!preflight.ownerMatches || !preflight.syncOk || preflight.connected) fail("isolated_archive_preflight_failed");
    for (const caseId of CASES.filter(value => approval.cases.includes(value))) {
      const previous = row.cases[caseId];
      if (previous?.ok || (previous && !approval.retryFailed)) continue;
      activeCase = caseId; blockedReason = "";
      const output = await page.evaluate(async ({ caseId, data }) => {
        try {
          const settings = await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS), owner = await pbpVocabCurrentOwner();
          const learner = { ...settings, dictLearnerNativeLanguage: data.nativeLanguage, dictLearnerLevel: data.level };
          const request = { term: data.term, sourceLanguage: data.sourceLanguage, target: pbpDictLearningTarget(learner, "zh-CN"),
            owner, settings: learner, isCurrent: () => true };
          if (request.target.lang !== data.explanationLanguage) return { ok: false, code: "target_preflight_failed" };
          if (caseId !== "entry" && !(await pbpDictArchiveRead(request))?.archiveId) return { ok: false, code: "parent_entry_unavailable" };
          // The category is the case: patterns and confusables are separate
          // paid requests, each saved on its own (Q8=A).
          const value = caseId === "entry" ? await pbpDictEntryRun(request) : await pbpDictSupplementRun({ ...request, category: caseId });
          const reread = await pbpDictArchiveRead(request);
          const durable = caseId === "entry" ? !!value.archiveId && reread?.archiveId === value.archiveId : !!value.id && reread?.supplements.some(item => item.id === value.id);
          const host = document.createElement("section"); host.className = "library-dict"; document.body.replaceChildren(host);
          const mount = _pbpDictEntryMount(host, { term: data.term, lang: data.sourceLanguage, owner, settings: request.settings, isCurrent: () => true });
          await mount.ready; mount.show("ai");
          for (const detail of host.querySelectorAll("details")) detail.open = true;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const visible = node => node.checkVisibility({ checkVisibilityCSS: true }) && node.getBoundingClientRect().height > 0;
          const content = host.querySelector(".xp-dict-ai-content");
          const meanings = [...host.querySelectorAll(".xp-dict-senses > li")].filter(visible).length;
          // The saved supplement is its own section inside the "usage points"
          // block, showing its items directly (a patterns card has no summary,
          // so the first item's explanation is what must be visible).
          const saved = caseId === "entry" ? null : reread?.supplements.find(item => item.id === value.id);
          const section = saved && host.querySelector('[data-learning-block="usage"] > [data-supplement-category="' + caseId + '"][data-supplement-id="' + CSS.escape(saved.id) + '"]');
          const shown = saved?.learning?.items?.[0]?.explanation;
          const supplementRendered = !!section && visible(section) && !!shown && !!section.querySelector(".xp-dict-supplement-text")?.textContent.includes(shown);
          const errors = [...host.querySelectorAll(".xp-dict-ai-status, .xp-dict-action-error")].filter(node => visible(node) && node.textContent.trim()).length;
          const rendered = !!content && visible(content) && meanings === reread?.entry.meanings.length && meanings > 0 && !errors &&
            (caseId === "entry" || supplementRendered);
          return { ok: durable && rendered, code: !durable ? "archive_not_confirmed" : !rendered ? "render_not_confirmed" : "saved_reread_and_rendered",
            preflight: { ownerMatches: owner === "acct_dict_live_fixture" }, render: { meanings, supplementRendered, errors }, value };
        } catch (error) {
          const code = ["invalid_response", "wrong_language", "unsupported_usage", "invalid_request", "host_permission", "endpoint_invalid", "model_not_found", "ai_disabled", "ai_not_configured", "sync_failed", "owner_changed", "not_saved"].includes(error?.code) ? error.code : "request_failed";
          return { ok: false, code, reason: typeof _pbpDictFailureReason === "function" ? _pbpDictFailureReason(error) : "" };
        }
      }, { caseId, data: plan.data }).catch(() => ({ ok: false, code: "browser_case_failed" }));
      if (blockedReason) output.bridgeReason = blockedReason;
      const safe = JSON.parse(redactText(JSON.stringify(output), [key]));
      const reportName = id + "-" + caseId + "-" + row.attempts.filter(a => a.caseId === caseId).length + ".json";
      writeJson(resolve(reportDir, reportName), { provider: id, model: config.model, caseId, ...safe });
      row.cases[caseId] = { ok: safe.ok, code: safe.code, report: reportName, at: new Date().toISOString() }; saveLedger();
      activeCase = "";
    }
  } finally { activeCase = ""; await context.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const option = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
  const configDir = resolve(option("--config-dir", CONFIG));
  const plan = buildPlan(readFileSync(resolve(configDir, "providers.env"), "utf8"));
  if (argv.includes("--rehearse")) {
    if (argv.includes("--live")) fail("conflicting_modes");
    // Offline response replay follows today's product budget. The historical
    // live plan and its approval limits remain unchanged and cannot be reused
    // to authorize the larger request.
    plan.limits = { ...plan.limits, entryOutputTokens: 8192, supplementOutputTokens: 8192 };
    const syntheticPlan = { ...plan }; delete syntheticPlan.planHash;
    plan.planHash = digest(syntheticPlan);
    const { entryResponse, patternsResponse, confusablesResponse } = await import("../tests/fixtures/dict-live-responses.mjs");
    const { chatCompletionStream } = await import("../tests/fixtures/dict-chat-stream.mjs");
    const approval = { providers: Object.keys(plan.providers), cases: CASES, retryFailed: false, diagnosticOutputTokens: null };
    mkdirSync(REPORT, { recursive: true, mode: 0o700 });
    const reportDir = mkdtempSync(resolve(REPORT, "rehearsal-")), ledger = newLedger(plan);
    const saveLedger = () => writeJson(resolve(reportDir, "ledger.json"), ledger);
    const dispatch = async (_url, options) => {
      // Chosen by the production prompt's opening line, never by provider.
      const content = JSON.parse(options.body).messages[0].content;
      const body = content.startsWith("Create one compact usage card") ? patternsResponse
        : content.startsWith("Create a concise language-learning supplement") ? confusablesResponse : entryResponse;
      // The product streams, so the handwritten answer goes back as the
      // chat.completion.chunk SSE body a compatible endpoint sends.
      return new Response(chatCompletionStream(body), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    // In-memory synthetic keys and responses only. This mode never reads .env,
    // invokes Node fetch, or shares the live ledger or browser profile.
    for (const id of approval.providers) await executeProvider(plan, approval, ledger, id, "synthetic-rehearsal-key", saveLedger, { reportDir, dispatch });
    const ok = Object.values(ledger.providers).every(row => CASES.every(id => row.cases[id]?.ok));
    process.stdout.write(JSON.stringify({ rehearsal: true, liveRequests: 0, reportDir, ok, ledger }, null, 2) + "\n");
    if (!ok) process.exitCode = 1;
    return;
  }
  if (!argv.includes("--live")) {
    process.stdout.write(JSON.stringify({ plan, approvalTemplate: { authorized: false, planHash: plan.planHash, authorizationReference: "",
      providers: Object.keys(plan.providers), cases: CASES, retryFailed: false, diagnosticOutputTokens: null } }, null, 2) + "\n");
    return;
  }
  validatePriceFreshness(plan);
  const approvalPath = option("--approval", ""); if (!approvalPath) fail("approval_required_or_mismatched");
  const approval = validateApproval(plan, JSON.parse(readFileSync(resolve(approvalPath), "utf8")));
  mkdirSync(REPORT, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(resolve(REPORT, "ledger.lock"));
  try {
    const ledgerPath = resolve(REPORT, "ledger.json"), ledger = existsSync(ledgerPath) ? validateLedger(plan, JSON.parse(readFileSync(ledgerPath, "utf8"))) : newLedger(plan);
    if (approval.minimaxLowFollowup) validateMinimaxLowFollowup(plan, ledger, approval);
    const saveLedger = () => writeJson(ledgerPath, ledger); saveLedger();
    // This is the only credential read. It is unreachable from --plan or an
    // unapproved invocation. Do not import values into process.env or Chromium.
    const privateFields = parseEnv(readFileSync(resolve(configDir, ".env"), "utf8"));
    const keys = Object.fromEntries(approval.providers.map(id => [id, privateFields[plan.providers[id].keyVariable]]));
    for (const id of approval.providers) if (typeof keys[id] !== "string" || !keys[id].trim()) fail("missing_" + plan.providers[id].keyVariable);
    for (const name of Object.keys(privateFields)) delete privateFields[name];
    for (const id of approval.providers) {
      await executeProvider(plan, approval, ledger, id, keys[id], saveLedger);
      delete keys[id];
    }
    process.stdout.write(JSON.stringify({ scope: SCOPE, providers: Object.fromEntries(approval.providers.map(id => [id, {
      currency: plan.providers[id].currency, requests: ledger.providers[id].attempts.length,
      reservedCost: ledger.providers[id].reservedMicros / 1e6, cases: ledger.providers[id].cases }])) }, null, 2) + "\n");
  } finally { unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write("[dict-live-test] " + (typeof error?.safeCode === "string" && /^[a-zA-Z0-9_]+$/.test(error.safeCode) ? error.safeCode : "preflight_or_harness_failed") + "\n"); process.exitCode = 1; });
}
