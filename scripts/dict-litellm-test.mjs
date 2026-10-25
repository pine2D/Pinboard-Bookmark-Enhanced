#!/usr/bin/env node
// One dictionary pipeline, several model aliases. Never read .env in plan,
// evidence or rehearsal mode. Prices come exclusively from ai-dev.sh estimate.
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { completionMetadata, completionReport, redactText } from "./dict-live-test.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(homedir(), ".config/ai-dev");
// A new authorization uses a new fixed ledger. The earlier 84-call ledger is
// immutable evidence; never reset it to obtain more requests.
const REPORT = resolve(REPO, ".qa-scan/report/dict-litellm-reliability-2026-10-26");
const AI_DEV = resolve(homedir(), "projects/scripts/ai-dev.sh");
const DUMMY = "dict-litellm-browser-placeholder";
const OWNER = "acct_dict_litellm_fixture";
const BASE = "http://127.0.0.1:48096/v1"; // Public ai-dev README, not .env.
export const MODELS = Object.freeze([
  { alias: "deepseek-flash", provider: "deepseek", model: "deepseek-flash", cap: .40 },
  { alias: "deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro", cap: 1.20 },
  { alias: "gemini/gemini-4-argon", provider: "gemini", model: "gemini-4-argon", cap: 2.30 },
  { alias: "gemini/gemini-3.8-flash", provider: "gemini", model: "gemini-3.8-flash", cap: 1.00 },
  { alias: "gemini/gemini-3.5-flash-lite", provider: "gemini", model: "gemini-3.5-flash-lite", cap: .60 },
  { alias: "dashscope/qwen3.8-max", provider: "dashscope", model: "qwen3.8-max", cap: 1.80 },
  { alias: "dashscope/qwen3.8-flash", provider: "dashscope", model: "qwen3.8-flash", cap: .20 }
]);
export const CASES = Object.freeze([
  { id: "provider-entry", term: "provider", kind: "entry", surface: "library" },
  { id: "based-entry", term: "based", kind: "entry", surface: "reader" },
  { id: "bank-entry", term: "bank", kind: "entry", surface: "library" },
  { id: "charge-entry", term: "charge", kind: "entry", surface: "reader" },
  ...["collocations", "confusables", "register", "grammar", "scenarios", "literature", "etymology"].map(kind =>
    ({ id: "provider-" + kind, term: "provider", kind, surface: "library" })),
  { id: "based-culture", term: "based", kind: "culture", surface: "reader" }
]);
const LIMITS = Object.freeze({ requestsPerModel: 14, requestsPerCase: 2, inputBytes: 24576,
  framingTokens: 1024, outputTokens: 8192, responseBytes: 262144, timeoutMs: 60000,
  transportRetries: 0, gatewayRetries: 0, gatewayFallbacks: false });
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slug = value => value.replace(/[^a-zA-Z0-9-]/g, "_");
const environment = () => Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "FONTCONFIG_FILE"]
  .filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]]));
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".pending", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".pending", path);
}
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

export function makePlan(estimates, createdAt = new Date().toISOString()) {
  const models = MODELS.map(model => {
    const estimate = estimates[model.alias], quote = estimate?.result, snapshot = estimate?.snapshot;
    if (quote?.status !== "estimated" || quote.provider !== model.provider ||
        ![model.model, model.provider + "/" + model.model].includes(quote.model) ||
        snapshot?.stale !== false || snapshot.currency !== "USD" ||
        quote.requests !== LIMITS.requestsPerModel || quote.input_tokens !== LIMITS.inputBytes + LIMITS.framingTokens ||
        quote.output_tokens !== LIMITS.outputTokens || !Number.isFinite(Number(quote.total_usd)) ||
        Number(quote.total_usd) <= 0 || Number(quote.total_usd) > model.cap ||
        !Number.isFinite(snapshot.fetched_at)) fail("price_unknown_stale_or_over_budget");
    const input = Number(quote.rates_usd_per_million_tokens?.input_cost_per_token);
    const output = Number(quote.rates_usd_per_million_tokens?.output_cost_per_token);
    if (![input, output].every(rate => Number.isFinite(rate) && rate > 0)) fail("price_invalid");
    return { ...model, input, output, quote };
  });
  const plan = { schema: 1, scope: "dictionary-litellm-reliability-2026-10-26", createdAt, baseUrl: BASE,
    keyVariable: "LITELLM_API_KEY", models, cases: CASES, limits: LIMITS, estimates,
    data: { sourceLanguage: "en", target: { lang: "zh-Hans", name: "简体中文" },
      nativeLanguage: "简体中文", level: "intermediate", topic: "工作沟通" },
    boundaries: {
      pipeline: "Same production custom/OpenAI-compatible adapter, prompts, validators, UI actions and archive for every alias; no model-specific dictionary branches.",
      credentials: "Only the authorized Node live process reads LITELLM_API_KEY from .env. Same-named inherited environment is ignored. Chromium gets a nonsecret placeholder.",
      evidence: "Production public-evidence retrieval is captured once before testing and replayed identically for every model; retrieval failures are reported separately.",
      accounting: "Every HTTP dispatch, including product parameter compatibility retries, consumes the persistent model/case/cost limits. Gateway retry header=0; disable_fallbacks=true. No transport retries.",
      output: "Production output limit, at most 8192 tokens including reasoning. Four synthetic English words, seven usage categories and independent etymology; all explanations in Simplified Chinese.",
      prices: "Only ai-dev.sh estimate. USD reference prices; not a billing guarantee. Stop on stale/unknown prices or unverified routing/pricing. No paid tools, search, media, cache creation or parallel requests.",
      review: "Inspect native-language explanations, meaning alignment, usefulness, source support, latency and token usage; transport success alone is not a quality pass."
    } };
  return { ...plan, planHash: hash(plan) };
}
function estimatesFromAiDev() {
  return Object.fromEntries(MODELS.map(model => [model.alias, JSON.parse(execFileSync("bash", [AI_DEV, "estimate",
    "--provider", model.provider, "--model", model.model, "--input-tokens", String(LIMITS.inputBytes + LIMITS.framingTokens),
    "--output-tokens", String(LIMITS.outputTokens), "--requests", String(LIMITS.requestsPerModel)],
  { encoding: "utf8", env: environment(), timeout: 15000, maxBuffer: 131072, stdio: ["ignore", "pipe", "pipe"] }))]));
}
export function validateApproval(plan, approval, now = Date.now()) {
  const { planHash, ...body } = plan;
  if (hash(body) !== planHash || makePlan(plan.estimates, plan.createdAt).planHash !== planHash || approval?.authorized !== true ||
      approval.planHash !== plan.planHash || !approval.authorizationReference?.trim() ||
      approval.allowDiagnosticRecheck !== true || !approval.evidence ||
      approval.evidenceHash !== hash(approval.evidence)) fail("specific_approval_required");
  if (!Number.isFinite(Date.parse(plan.createdAt)) || now - Date.parse(plan.createdAt) > 25 * 3600000 ||
      Object.values(plan.estimates).some(row => now - row.snapshot.fetched_at * 1000 > 25 * 3600000)) fail("price_expired");
  return approval;
}
export function newLedger(plan) {
  return { schema: 1, planHash: plan.planHash, models: Object.fromEntries(plan.models.map(model =>
    [model.alias, { reservedMicros: 0, attempts: [], cases: {} }])) };
}
export function reserve(plan, ledger, alias, caseId, inputBytes, outputTokens) {
  if (ledger?.schema !== 1 || ledger.planHash !== plan.planHash) fail("ledger_mismatch");
  const model = plan.models.find(row => row.alias === alias), row = ledger.models?.[alias];
  if (!model || !row || !Array.isArray(row.attempts) || !row.cases ||
      row.attempts.some(item => !Number.isSafeInteger(item.reservedMicros) || item.reservedMicros < 0) ||
      row.reservedMicros !== row.attempts.reduce((sum, item) => sum + item.reservedMicros, 0)) fail("ledger_invalid");
  if (!CASES.some(item => item.id === caseId) || !Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > LIMITS.inputBytes ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > LIMITS.outputTokens) fail("request_bounds");
  if (row.attempts.length >= LIMITS.requestsPerModel || row.attempts.filter(item => item.caseId === caseId).length >= LIMITS.requestsPerCase) fail("request_limit");
  const reservedMicros = Math.ceil((inputBytes + LIMITS.framingTokens) * model.input + outputTokens * model.output);
  if (row.reservedMicros + reservedMicros > Math.floor(model.cap * 1e6)) fail("cost_limit");
  const attempt = { caseId, inputBytes, outputTokens, reservedMicros, state: "reserved", at: new Date().toISOString() };
  row.attempts.push(attempt); row.reservedMicros += reservedMicros; return attempt;
}
export async function boundedBody(response, maximum) {
  const reader = response.body?.getReader(); if (!reader) fail("response_missing");
  const parts = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) fail("response_too_large"); parts.push(value); }
    return Buffer.concat(parts).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

export function verifyReturnedUsage(attempt) {
  const output = attempt.usage?.completion_tokens;
  const input = attempt.usage?.prompt_tokens;
  if (Number.isFinite(output) && output > attempt.outputTokens) fail("gateway_output_limit_exceeded");
  if (Number.isFinite(input) && input > attempt.inputBytes + LIMITS.framingTokens) fail("gateway_input_limit_exceeded");
}

export function requestInputBytes(body) {
  const format = body.response_format;
  if (format !== undefined) {
    const objectMode = JSON.stringify(format) === '{"type":"json_object"}';
    const schema = format?.json_schema;
    const schemaMode = format?.type === "json_schema" && Object.keys(format).length === 2 &&
      schema?.name === "response" && schema.strict === true && Object.keys(schema).length === 3 &&
      schema.schema?.type === "object" && schema.schema.additionalProperties === false;
    if (!objectMode && !schemaMode) fail("request_shape");
  }
  // Schema tokens are billed input too. Count every message and format byte,
  // then reserve the separately approved framing allowance before dispatch.
  return Buffer.byteLength(JSON.stringify({ messages: body.messages, ...(format ? { response_format: format } : {}) }), "utf8");
}

export function httpErrorMetadata(body) {
  const error = body?.error;
  const detail = [error?.message, error?.type, error?.code, error?.param]
    .filter(value => typeof value === "string").join(" ").toLowerCase();
  // Only fixed labels leave this classifier. Provider errors can contain
  // credentials or echoed input; never retain their arbitrary text or fields.
  return { mentionedParameters: ["response_format", "json_schema", "json_object", "max_tokens", "max_completion_tokens", "reasoning_effort", "temperature"]
    .filter(name => new RegExp("\\b" + name + "\\b").test(detail)),
    formatEnumRefusal: /\bresponse_format\b/.test(detail) && /\bjson_(?:schema|object)\b/.test(detail) &&
      /unknown\s+variant|(?:must|should)\s+be\s+(?:one\s+of|either|["'`]*(?:text|json_object)\b)/.test(detail) };
}

export function reusableEntries(ledger, alias, caseIds) {
  if (!MODELS.some(model => model.alias === alias)) fail("reused_entry_model_unknown");
  const cases = caseIds.map(id => CASES.find(item => item.id === id));
  if (cases.some(item => !item || item.kind === "entry")) fail("reuse_only_for_supplements");
  return [...new Set(cases.map(item => item.term))].map(term => {
    const result = ledger.models[alias]?.cases[term + "-entry"];
    if (!result?.ok || result.value?.word !== term || result.value.language !== "en") fail("reused_entry_unverified");
    return { term, entry: structuredClone(result.value), model: alias };
  });
}

async function launch(profile, extension = true) {
  const { chromium } = createRequire(resolve(REPO, ".qa-scan/package.json"))("playwright");
  return chromium.launchPersistentContext(profile, { headless: true, executablePath: chromium.executablePath(),
    env: environment(), args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
      ...(extension ? [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`] : [])] });
}

// No AI or credential access: production retrieval, bounded anonymous GETs only.
async function collectEvidence(reportDir) {
  const context = await launch(resolve(reportDir, "evidence-profile"), false);
  let count = 0; const evidence = {}, requests = [];
  try {
    const page = await context.newPage();
    await context.route(/^https?:/, async route => {
      try {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || !["en.wiktionary.org", "en.wikipedia.org", "en.wikisource.org"].includes(url.hostname) ||
            url.protocol !== "https:" || url.pathname !== "/w/api.php" || !["query", "parse"].includes(url.searchParams.get("action")) || ++count > 104) fail("evidence_request_bounds");
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000), credentials: "omit" });
        requests.push({ url: url.href, status: response.status });
        await route.fulfill({ status: response.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: await boundedBody(response, 1800000) });
      } catch { await route.abort(); }
    });
    await page.goto("file://" + resolve(REPO, "tests/fixtures/dict-evidence-harness.html"));
    for (const [term, kind] of [["provider", "etymology"], ["based", "etymology"], ["provider", "literature"], ["based", "culture"]]) {
      evidence[term + ":" + kind] = await page.evaluate(async ({ term, kind }) => {
        try { return { ok: true, sources: await pbpDictEvidenceFetch({ term, sourceLanguage: "en", kind, beforeRequest: async () => {} }) }; }
        catch (error) { return { ok: false, code: ["source_failed", "host_permission"].includes(error.code) ? error.code : "source_failed", sources: [] }; }
      }, { term, kind });
    }
    writeJson(resolve(reportDir, "evidence.json"), { capturedAt: new Date().toISOString(), evidence, requests });
    return Object.fromEntries(Object.entries(evidence).map(([id, row]) => [id, { ok: row.ok, sources: row.sources.length }]));
  } finally { await context.close(); }
}

async function setupPage(page, surface, extensionId, evidence) {
  await page.goto("chrome-extension://" + extensionId + (surface === "library" ? "/library.html#vocab" : "/md-preview.html"));
  await page.waitForFunction(() => typeof _pbpDictEntryMount === "function" && typeof pbpDictArchiveRead === "function");
  await page.evaluate(({ base, evidence }) => {
    const allowed = new Set([new URL(base).origin, "https://en.wiktionary.org", "https://en.wikipedia.org", "https://en.wikisource.org"]);
    chrome.permissions.contains = async ({ origins }) => origins.every(origin => allowed.has(origin.replace(/\/\*$/, "")));
    chrome.permissions.request = chrome.permissions.contains;
    pbpDictEvidenceFetch = async ({ term, kind }) => {
      const row = evidence[term + ":" + kind];
      if (!row?.ok) throw Object.assign(new Error("source_failed"), { code: "source_failed" });
      return structuredClone(row.sources);
    };
    window.dictTestState = { calls: 0, pending: 0, actions: 0, actionPending: 0, error: "", reason: "", stages: [] };
    const mount = _pbpDictEntryMount;
    _pbpDictEntryMount = (...args) => { const result = mount(...args); window.dictTestMount = result; return result; };
    const warn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("[dict-entry]") && window.dictTestState) {
        if (/^[a-z_0-9]+$/.test(args[2] || "")) dictTestState.error = args[2];
        if (/^[a-z_0-9]+$/.test(args[3] || "")) dictTestState.reason = args[3];
      }
      warn(...args);
    };
    const original = callAI;
    callAI = async (...args) => {
      const state = dictTestState; state.calls++; state.pending++;
      try { return await original(...args); }
      catch (error) { state.error = _pbpDictFailureCode(error); state.reason = _pbpDictFailureReason(error); throw error; }
      finally { state.pending--; }
    };
    const wrap = original => async (...args) => {
      const state = dictTestState; state.actions++; state.actionPending++;
      const onStage = args[0].onStage;
      args[0] = { ...args[0], onStage: stage => {
        state.stages.push({ stage, at: Date.now() }); onStage?.(stage);
      } };
      try { return await original(...args); } finally { state.actionPending--; }
    };
    pbpDictEntryRun = wrap(pbpDictEntryRun); pbpDictSupplementRun = wrap(pbpDictSupplementRun);
  }, { base: BASE, evidence });
}
async function mountCase(page, testCase) {
  await page.evaluate(async ({ testCase, owner }) => {
    window.dictTestState = { calls: 0, pending: 0, actions: 0, actionPending: 0, error: "", reason: "", stages: [] };
    if (testCase.surface === "library") {
      _vocabCurrentOwner = owner;
      _pbpVocabDictCtrl?.abort(); _pbpVocabDictCtrl = new AbortController();
      const els = _pbpVocabRefSlot();
      _pbpVocabDictRun(testCase.term, "en", els, "", () => {}, { online: false });
      window.dictTestHost = document.getElementById("vocab-ref");
      await window.dictTestMount.ready;
    } else {
      window.dictTestController?.abort(); window.dictTestHost?.remove();
      window.dictTestController = new AbortController();
      const host = document.createElement("div"); host.className = "xp-dict";
      Object.assign(host.style, { position: "fixed", display: "block", top: "12px", left: "12px", width: "640px", maxHeight: "90vh", overflow: "auto" });
      document.body.append(host); window.dictTestHost = host;
      const mount = _pbpDictEntryMount(host, { term: testCase.term, lang: "en", owner, signal: dictTestController.signal,
        settings: pbpAiGetSettings(), isCurrent: () => !dictTestController.signal.aborted });
      await mount.ready; mount.show("ai");
    }
    const settings = deobfuscateSettings(await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS));
    window.dictTestRecord = await pbpDictArchiveRead({ term: testCase.term, sourceLanguage: "en",
      target: pbpDictLearningTarget(settings, "zh-CN"), owner, settings, isCurrent: () => true });
    const replaced = new Set((dictTestRecord?.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
    window.dictTestPrevious = testCase.kind === "entry" ? dictTestRecord?.generatedAt :
      dictTestRecord?.supplements.find(item => item.category === testCase.kind && !replaced.has(item.id))?.id;
  }, { testCase, owner: OWNER });
  await page.waitForFunction(() => dictTestHost.querySelector(".xp-dict-ai-generate")?.disabled === false);
}

async function runModel(plan, ledger, model, key, approval, options) {
  const { reportDir, dispatch, recheck, diagnosticTokens, selectedCases, reuseEntryFrom } = options;
  const modelSlug = slug(model.alias), row = ledger.models[model.alias];
  const productHash = hash(["ai.js", "dict-entry.js", "dict-evidence.js", "dict-archive.js", "md-dict.js", "library-vocab.js", "shared.js"]
    .map(file => [file, readFileSync(resolve(REPO, file), "utf8")]));
  if (!recheck && ledger.baselineProductHash && ledger.baselineProductHash !== productHash) fail("baseline_product_changed");
  ledger.baselineProductHash ||= productHash;
  const context = await launch(resolve(reportDir, "profiles", modelSlug));
  let active = null, bridgeError = "";
  const pendingBridges = new Set();
  const save = () => writeJson(resolve(reportDir, "ledger.json"), ledger);
  try {
    await context.route(/^https?:/, async route => {
      let attempt; const requestCase = active;
      let finish; const pending = new Promise(resolve => { finish = resolve; }); pendingBridges.add(pending);
      try {
        const request = route.request();
        if (!active || request.method() !== "POST" || request.url() !== BASE + "/chat/completions") fail("unapproved_network");
        const body = request.postDataJSON(), auth = request.headers()["authorization"];
        // Validate the real storage -> decoding -> caller path before replacing
        // the placeholder. A bridge must never conceal another obf: regression.
        if (auth !== "Bearer " + DUMMY) fail("credential_routing_failed");
        const fields = new Set(["model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "reasoning_effort", "response_format"]);
        if (Object.keys(body).some(field => !fields.has(field)) || body.model !== model.alias || body.stream || body.tools || body.tool_choice ||
            !Array.isArray(body.messages) || body.messages.length !== 1 || body.messages[0].role !== "user" || typeof body.messages[0].content !== "string") fail("request_shape");
        const inputBytes = requestInputBytes(body);
        const payload = JSON.parse(body.messages[0].content.split("\n").at(-1));
        if (payload.term !== requestCase.term || !!payload.baseEntry !== (requestCase.kind !== "entry") ||
            (payload.category !== undefined && payload.category !== requestCase.kind)) fail("case_identity_mismatch");
        const tokenField = Object.hasOwn(body, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
        if (Object.hasOwn(body, "max_completion_tokens") && Object.hasOwn(body, "max_tokens")) fail("request_shape");
        if (diagnosticTokens) body[tokenField] = diagnosticTokens;
        // Per-request controls, not persistent gateway configuration:
        // docs.litellm.ai/docs/routing and /docs/proxy/reliability.
        body.disable_fallbacks = true; body.num_retries = 0;
        attempt = reserve(plan, ledger, model.alias, requestCase.id, inputBytes, body[tokenField]);
        attempt.productHash = productHash;
        const responseReport = modelSlug + "-" + requestCase.id + "-" + row.attempts.length + ".json";
        save(); const start = performance.now();
        const response = await dispatch(BASE + "/chat/completions", { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "x-litellm-num-retries": "0", "Cache-Control": "no-store" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(LIMITS.timeoutMs) });
        attempt.httpStatus = response.status;
        const responseCost = response.headers.get("x-litellm-response-cost");
        if (responseCost !== null && Number.isFinite(Number(responseCost)) && Number(responseCost) >= 0) attempt.reportedCostUSD = Number(responseCost);
        if (Number(response.headers.get("x-litellm-attempted-retries") || 0) > 0 ||
            Number(response.headers.get("x-litellm-attempted-fallbacks") || 0) > 0) fail("gateway_retry_detected");
        if (attempt.reportedCostUSD > attempt.reservedMicros / 1e6) fail("gateway_cost_exceeded_reservation");
        const safeBody = redactText(await boundedBody(response, LIMITS.responseBytes), [key]);
        let parsed; try { parsed = JSON.parse(safeBody); } catch {}
        Object.assign(attempt, completionMetadata(parsed), { state: "received", latencyMs: Math.round(performance.now() - start) });
        if (!response.ok) attempt.httpError = httpErrorMetadata(parsed);
        const answer = response.ok ? completionReport(parsed, [key]) : null;
        if (answer) {
          attempt.responseReport = responseReport;
          writeJson(resolve(reportDir, attempt.responseReport), { model: model.alias, caseId: requestCase.id,
            request: { ...body, messages: body.messages.map(message => ({ ...message, content: redactText(message.content, [key]) })) }, ...answer });
        }
        save(); verifyReturnedUsage(attempt);
        await route.fulfill({ status: response.status, contentType: "application/json", body: safeBody });
      } catch (error) {
        bridgeError = error?.safeCode || (error?.name === "TimeoutError" ? "transport_timeout" : "transport_failed");
        if (attempt) {
          if (attempt.state === "received") attempt.deliveryFailure = bridgeError;
          else { attempt.state = "failed_or_uncertain"; attempt.failure = bridgeError; }
          save();
        }
        await route.abort().catch(() => {});
      } finally { pendingBridges.delete(pending); finish(); }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    await worker.evaluate(async ({ model, dummy, base }) => {
      if (typeof primeSettings === "function") await primeSettings();
      await chrome.storage.local.set({ optSyncEnabled: false, syncApiKeys: false, optLang: "zh_CN", previewAiEnabled: true,
        pinboardToken: obfuscateKey("dict_litellm_fixture:nonsecret_token"), _hlOwnerClaimDone: true,
        aiProvider: "custom", customApiKey: obfuscateKey(dummy), customModel: model.alias, customBaseUrl: base,
        previewAiModelByProvider: {}, dictDefaultView: "ai-saved", dictDefinitionLang: "简体中文",
        dictLearnerNativeLanguage: "简体中文", dictLearnerLevel: "intermediate" });
    }, { model, dummy: DUMMY, base: BASE });
    const pages = {};
    for (const surface of ["library", "reader"]) {
      pages[surface] = await context.newPage();
      await setupPage(pages[surface], surface, new URL(worker.url()).hostname, approval.evidence);
    }
    const preflight = await pages.library.evaluate(async () => {
      const owner = await pbpVocabCurrentOwner();
      const sync = await chrome.runtime.sendMessage({ type: "PBP_DICT_ARCHIVE_SYNC", owner });
      return { owner, ok: sync?.ok === true, connected: sync?.connected === true };
    });
    if (preflight.owner !== OWNER || !preflight.ok || preflight.connected) fail("archive_isolation_failed");
    if (reuseEntryFrom) {
      const entries = reusableEntries(ledger, reuseEntryFrom, selectedCases);
      const seeded = await pages.library.evaluate(async ({ entries, owner }) => {
        const settings = deobfuscateSettings(await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS));
        const target = pbpDictLearningTarget(settings, "zh-CN"), used = [];
        for (const item of entries) {
          const input = { owner, term: item.term, sourceLanguage: "en", target, settings, isCurrent: () => true };
          if (await pbpDictArchiveRead(input)) continue;
          await pbpDictArchiveSave({ ...input, record: { entry: item.entry, provider: "custom", model: item.model, generatedAt: Date.now() } });
          used.push({ term: item.term, model: item.model });
        }
        return used;
      }, { entries, owner: OWNER });
      // This exercises the normal saved-entry / new-provider supplement path.
      // Never relabel the target model's failed entry generation as successful.
      row.reusedEntries = [...(row.reusedEntries || []), ...seeded]; save();
    }
    for (const testCase of CASES.filter(item => selectedCases.includes(item.id))) {
      if (row.cases[testCase.id] && !recheck) continue;
      if (row.attempts.length >= LIMITS.requestsPerModel) break;
      if (!recheck && row.attempts.some(item => item.caseId === testCase.id)) continue;
      // Do not pay to repeat a proven empty-reasoning truncation across the
      // remaining categories. Preserve that allowance for a diagnosed recheck.
      if (!recheck && row.attempts.length >= 2 && row.attempts.slice(-2).every(item => item.finishReason === "length" && item.contentEmpty)) {
        row.cases[testCase.id] = { ok: false, calls: 0, deferred: "consecutive_empty_truncations" }; save(); continue;
      }
      active = testCase; bridgeError = ""; const page = pages[testCase.surface];
      try { await mountCase(page, testCase); }
      catch (error) {
        writeJson(resolve(reportDir, "mount-diagnostic.json"), await page.evaluate(() => ({
          host: !!window.dictTestHost, connected: window.dictTestHost?.isConnected,
          html: window.dictTestHost?.outerHTML?.slice(0, 16000),
          state: window.dictTestState, owner: typeof _vocabCurrentOwner === "string" ? _vocabCurrentOwner : "reader"
        })));
        throw error;
      }
      const triggered = await page.evaluate(({ testCase, topic }) => {
        if (testCase.kind === "entry") {
          const button = dictTestHost.querySelector(".xp-dict-update-entry") || dictTestHost.querySelector(".xp-dict-ai-generate");
          button.click(); return true;
        }
        if (testCase.kind === "etymology") {
          const previous = dictTestRecord?.supplements.find(item => item.category === "etymology" &&
            !(dictTestRecord.supplements || []).some(next => next.learning?.replacesId === item.id));
          const button = previous ? dictTestHost.querySelector('[data-supplement-id="' + CSS.escape(previous.id) + '"] .xp-dict-update-supplement')
            : dictTestHost.querySelector('.xp-dict-etymology-generate');
          if (!button) return false;
          button.closest('details').open = true; button.click(); return true;
        }
        const kind = dictTestHost.querySelector(".xp-dict-supplement-kind"); if (!kind) return false;
        const disclosure = kind.closest("details"); disclosure.open = true;
        kind.value = testCase.kind; kind.dispatchEvent(new Event("change", { bubbles: true }));
        const input = dictTestHost.querySelector(".xp-dict-supplement-topic");
        input.value = ["scenarios", "register", "collocations"].includes(testCase.kind) ? topic : "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const replaced = new Set((dictTestRecord?.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
        const previous = dictTestRecord?.supplements.find(item => item.category === testCase.kind && !replaced.has(item.id));
        const update = previous && dictTestHost.querySelector('[data-supplement-id="' + CSS.escape(previous.id) + '"] .xp-dict-update-supplement');
        if (update) update.click(); else dictTestHost.querySelector(".xp-dict-supplement-generate").click(); return true;
      }, { testCase, topic: plan.data.topic });
      if (triggered) await page.waitForFunction(kind => {
        const button = dictTestHost.querySelector(kind === "entry" ? ".xp-dict-ai-generate" : ".xp-dict-supplement-generate");
        return (dictTestState.actions > 0 || dictTestState.error) && dictTestState.actionPending === 0 && dictTestState.pending === 0 && button?.disabled === false;
      }, testCase.kind, { timeout: LIMITS.timeoutMs + 15000 });
      // Browser-side product timeout can finish before the bridge's response.
      // Drain it before the next case and keep its original case/report identity.
      await Promise.allSettled([...pendingBridges]);
      const result = await page.evaluate(async ({ testCase, owner }) => {
        const settings = deobfuscateSettings(await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS));
        const record = await pbpDictArchiveRead({ term: testCase.term, sourceLanguage: "en", target: pbpDictLearningTarget(settings, "zh-CN"), owner, settings, isCurrent: () => true });
        const replaced = new Set((record?.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
        const value = testCase.kind === "entry" ? record?.entry : record?.supplements.find(item => item.category === testCase.kind && !replaced.has(item.id));
        const content = dictTestHost.querySelector(".xp-dict-ai-content"), text = content?.textContent || "";
        const visible = !!content?.checkVisibility({ checkVisibilityCSS: true }) && content.getBoundingClientRect().height > 0;
        const expected = testCase.kind === "entry" ? value?.meanings[0]?.definition : value?.learning?.summary;
        const changed = testCase.kind === "entry" ? record?.generatedAt !== dictTestPrevious : value?.id !== dictTestPrevious;
        return { ok: !!expected && visible && text.includes(expected) && changed && dictTestState.calls > 0 && !dictTestState.error,
          archived: !!value, changed, rendered: !!expected && visible && text.includes(expected),
          partial: !!value?.learning?.omittedItems,
          ...dictTestState, status: [...dictTestHost.querySelectorAll("[role='status'], .xp-dict-action-error")].map(node => node.textContent).filter(Boolean), value };
      }, { testCase, owner: OWNER });
      row.cases[testCase.id] = { ...result, productHash, bridgeError, at: new Date().toISOString() };
      const reused = row.reusedEntries?.find(item => item.term === testCase.term);
      if (reused && testCase.kind !== "entry") row.cases[testCase.id].baseEntryModel = reused.model;
      save(); process.stdout.write(JSON.stringify({ model: model.alias, case: testCase.id, ok: result.ok, error: bridgeError || result.error, calls: result.calls }) + "\n");
      active = null;
      if (["gateway_retry_detected", "gateway_cost_exceeded_reservation", "gateway_output_limit_exceeded", "gateway_input_limit_exceeded"].includes(bridgeError)) fail(bridgeError);
    }
  } finally { await context.close(); }
}

// Authenticated metadata only, before any model request. Never retain the raw
// response: model configuration can contain credentials in some deployments.
export function verifyGatewayMetadata(plan, data, selected) {
  const verified = [];
  for (const model of plan.models.filter(row => selected.includes(row.alias))) {
    const matches = data?.data?.filter(row => row.model_name === model.alias);
    if (matches?.length !== 1) fail("gateway_route_unverified");
    const row = matches[0], actual = row.litellm_params?.model;
    const provider = row.model_info?.litellm_provider || row.litellm_params?.custom_llm_provider;
    if (actual !== model.provider + "/" + model.model && !(actual === model.model && provider === model.provider)) fail("gateway_route_unverified");
    const info = row.model_info;
    const input = Number(info?.input_cost_per_token), output = Number(info?.output_cost_per_token);
    const exceeds = (actual, limit) => actual - limit > Number.EPSILON * Math.max(actual, limit) * 2;
    if (![input, output].every(rate => Number.isFinite(rate) && rate > 0) ||
        exceeds(input, model.input / 1e6) || exceeds(output, model.output / 1e6)) fail("gateway_price_unverified");
    verified.push({ model: model.alias, provider: model.provider, priceWithinPlan: true });
  }
  return verified;
}

export async function main(args = process.argv.slice(2)) {
  const arg = name => args[args.indexOf(name) + 1];
  const reportDir = args.includes("--report-dir") ? resolve(arg("--report-dir")) : REPORT;
  if (args.includes("--evidence")) { textOutput(await collectEvidence(reportDir)); return; }
  if (!args.includes("--live") && !args.includes("--rehearse")) {
    const plan = makePlan(estimatesFromAiDev());
    if (args.includes("--prepare")) {
      if (existsSync(resolve(reportDir, "ledger.json"))) fail("live_scope_already_started");
      writeJson(resolve(reportDir, "plan.json"), plan);
    }
    textOutput({ planHash: plan.planHash, cases: plan.cases, limits: plan.limits,
      models: plan.models.map(({ alias, cap, quote }) => ({ model: alias, capUSD: cap, estimateUSD: quote.total_usd, region: quote.region })) }); return;
  }
  const rehearsal = args.includes("--rehearse");
  if (rehearsal && args.includes("--live")) fail("mode_conflict");
  if (!rehearsal && reportDir !== REPORT) fail("live_ledger_location_fixed");
  const plan = readJson(resolve(reportDir, "plan.json"));
  const approval = rehearsal ? { evidence: (await import("../tests/fixtures/dict-litellm-responses.mjs")).evidence } :
    validateApproval(plan, readJson(args.includes("--approval") ? resolve(arg("--approval")) : fail("specific_approval_required")));
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const outputDir = rehearsal ? mkdtempSync(resolve(reportDir, "rehearsal-")) : reportDir;
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const lock = resolve(outputDir, "run.lock");
  try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); } catch { fail("ledger_locked"); }
  try {
    const ledgerPath = resolve(outputDir, "ledger.json"), started = resolve(outputDir, "scope.started");
    if (existsSync(started) && !existsSync(ledgerPath)) fail("existing_ledger_missing");
    const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : newLedger(plan);
    if (ledger.planHash !== plan.planHash) fail("ledger_mismatch");
    writeJson(ledgerPath, ledger);
    if (!existsSync(started)) writeFileSync(started, plan.planHash + "\n", { mode: 0o600, flag: "wx" });
    const selected = args.includes("--model") ? [arg("--model")] : MODELS.map(row => row.alias);
    const selectedCases = args.includes("--cases") ? arg("--cases").split(",") : CASES.map(row => row.id);
    if (selected.some(alias => !MODELS.some(row => row.alias === alias)) || selectedCases.some(id => !CASES.some(row => row.id === id))) fail("scope_mismatch");
    const diagnosticTokens = args.includes("--diagnostic-tokens") ? Number(arg("--diagnostic-tokens")) : 0;
    const reuseEntryFrom = args.includes("--reuse-entry-from") ? arg("--reuse-entry-from") : "";
    if (rehearsal && reuseEntryFrom) {
      const donor = plan.models.find(model => model.alias === reuseEntryFrom);
      if (!donor) fail("reused_entry_model_unknown");
      // Exercise the complete donor generation/save/read path with independent
      // offline responses; never manufacture a passing live ledger case.
      await runModel(plan, ledger, donor, DUMMY, approval, { reportDir: outputDir,
        dispatch: (await import("../tests/fixtures/dict-litellm-responses.mjs")).dispatch,
        selectedCases: [...new Set(selectedCases.map(id => CASES.find(item => item.id === id).term + "-entry"))],
        recheck: false, diagnosticTokens, reuseEntryFrom: "" });
    }
    if (reuseEntryFrom) reusableEntries(ledger, reuseEntryFrom, selectedCases);
    if (diagnosticTokens && (!args.includes("--recheck") || !Number.isSafeInteger(diagnosticTokens) || diagnosticTokens > LIMITS.outputTokens || diagnosticTokens < 1)) fail("diagnostic_bounds");
    // This is the only credential read, after concrete approval and preflight.
    // Never source or inherit provider environment; never pass keys to Chromium.
    let key = DUMMY;
    if (!rehearsal) {
      const fields = parseEnv(readFileSync(resolve(CONFIG, ".env"), "utf8")); key = fields.LITELLM_API_KEY;
      for (const name of Object.keys(fields)) delete fields[name];
      if (!key?.trim()) fail("missing_LITELLM_API_KEY");
      const response = await fetch(new URL("/model/info", BASE), { headers: { Authorization: "Bearer " + key },
        redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) fail("gateway_metadata_http_" + response.status);
      const metadata = JSON.parse(await boundedBody(response, 1500000));
      writeJson(resolve(outputDir, "gateway-metadata-check.json"), { models: (Array.isArray(metadata?.data) ? metadata.data : [])
        .filter(row => selected.includes(row.model_name)).map(row => ({ alias: row.model_name,
          modelMatches: row.litellm_params?.model === MODELS.find(model => model.alias === row.model_name)?.provider + "/" + MODELS.find(model => model.alias === row.model_name)?.model,
          bareModelMatches: row.litellm_params?.model === MODELS.find(model => model.alias === row.model_name)?.model,
          providerMatches: (row.model_info?.litellm_provider || row.litellm_params?.custom_llm_provider) === MODELS.find(model => model.alias === row.model_name)?.provider,
          inputRate: typeof row.model_info?.input_cost_per_token === "number" ? row.model_info.input_cost_per_token : null,
          outputRate: typeof row.model_info?.output_cost_per_token === "number" ? row.model_info.output_cost_per_token : null })) });
      const verified = verifyGatewayMetadata(plan, metadata, selected);
      writeJson(resolve(outputDir, "preflight.json"), { verified, at: new Date().toISOString() });
    }
    const dispatch = rehearsal ? (await import("../tests/fixtures/dict-litellm-responses.mjs")).dispatch : fetch;
    for (const model of plan.models.filter(row => selected.includes(row.alias))) await runModel(plan, ledger, model, key, approval,
      { reportDir: outputDir, dispatch, recheck: args.includes("--recheck"), diagnosticTokens, selectedCases, reuseEntryFrom });
    if (rehearsal) textOutput({ rehearsalDirectory: outputDir, realRequests: 0 });
  } finally { unlinkSync(lock); }
}
function textOutput(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  if (!process.argv.includes("--live")) process.stderr.write(String(error?.stack || error) + "\n");
  process.stderr.write("[dict-litellm-test] " + (/^[a-z_0-9]+$/i.test(error?.safeCode || "") ? error.safeCode : "preflight_or_harness_failed") + "\n"); process.exitCode = 1;
});
