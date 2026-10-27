// No live endpoints, credentials, or browser profile are used by this suite.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildPlan, validateApproval, validatePriceFreshness, validateMinimaxLowFollowup, newLedger, validateLedger, reserveAttempt, redactText, completionMetadata, completionReport, streamCompletion, readAnswerBody, isProductRequest } from "../scripts/dict-live-test.mjs";

const PUBLIC = `DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
MINIMAX_BASE_URL=https://api.minimax.cn/v1
MINIMAX_MODEL=MiniMax-M3.1-Flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-3.8-flash
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-6.1-sol
`;
const approved = plan => ({ authorized: true, planHash: plan.planHash, authorizationReference: "synthetic-unit-fixture",
  providers: ["deepseek"], cases: ["entry", "patterns", "confusables"], retryFailed: false, diagnosticOutputTokens: null });
const code = expected => error => error.safeCode === expected;
const lowApproval = plan => ({ ...approved(plan), providers: ["minimax"], cases: ["patterns"], retryFailed: true, minimaxLowFollowup: true });
function exhaustedMinimax(plan) {
  const ledger = newLedger(plan);
  for (const caseId of ["entry", "entry", "patterns", "patterns"]) {
    const item = reserveAttempt(plan, ledger, "minimax", caseId, 2000, 2048);
    Object.assign(item, { state: "received", httpStatus: 200, finishReason: "length", contentEmpty: true });
  }
  ledger.providers.minimax.cases = { entry: { ok: true }, patterns: { ok: false } };
  return ledger;
}

test("a low-effort followup needs separate authorization for exactly one MiniMax supplement", () => {
  const plan = buildPlan(PUBLIC), value = lowApproval(plan), ledger = exhaustedMinimax(plan);
  assert.equal(validateMinimaxLowFollowup(plan, ledger, value), true);
  for (const patch of [{ authorized: false }, { minimaxLowFollowup: "true" }, { planHash: "other" }]) {
    assert.throws(() => validateApproval(plan, { ...value, ...patch }), code("approval_required_or_mismatched"));
  }
  for (const patch of [{ providers: ["deepseek"] }, { cases: ["entry"] }, { cases: ["entry", "patterns"] }, { cases: ["confusables"] },
    { providers: ["minimax", "deepseek"] }, { retryFailed: false }, { diagnosticOutputTokens: 8192 }]) {
    assert.throws(() => validateApproval(plan, { ...value, ...patch }), code("followup_approval_invalid"));
  }
  assert.throws(() => validateMinimaxLowFollowup(plan, ledger, { ...value, minimaxLowFollowup: false }), code("followup_approval_invalid"));
});
test("the followup cannot replace the baseline ledger or reuse a successful case", () => {
  const plan = buildPlan(PUBLIC), value = lowApproval(plan);
  assert.throws(() => validateMinimaxLowFollowup(plan, newLedger(plan), value), code("followup_ledger_ineligible"));
  for (const change of [row => { row.cases.entry.ok = false; }, row => { row.cases.patterns.ok = true; },
    row => { row.attempts.forEach(item => { item.contentEmpty = false; }); }]) {
    const ledger = exhaustedMinimax(plan); change(ledger.providers.minimax);
    assert.throws(() => validateMinimaxLowFollowup(plan, ledger, value), code("followup_ledger_ineligible"));
  }
});
test("one followup persists in the original cost ledger and blocks a second HTTP dispatch", () => {
  const plan = buildPlan(PUBLIC), ledger = exhaustedMinimax(plan), approval = lowApproval(plan);
  const previous = ledger.providers.minimax.reservedMicros;
  assert.throws(() => reserveAttempt(plan, ledger, "minimax", "patterns", 2000, 2048), code("request_budget_exhausted"));
  const item = reserveAttempt(plan, ledger, "minimax", "patterns", 24576, 2048, approval);
  item.state = "failed_or_uncertain";
  assert.equal(item.authorizationScope, "minimax-low-followup");
  assert.ok(item.reservedMicros <= 40000);
  assert.equal(ledger.providers.minimax.reservedMicros, previous + item.reservedMicros);
  const restarted = validateLedger(plan, JSON.parse(JSON.stringify(ledger)));
  assert.throws(() => reserveAttempt(plan, restarted, "minimax", "patterns", 2000, 2048, approval), code("followup_ledger_ineligible"));
  assert.equal(restarted.providers.minimax.attempts.length, 5);
});
test("followup keeps the original money cap and refuses other providers, cases or output budgets", () => {
  const plan = buildPlan(PUBLIC), ledger = exhaustedMinimax(plan), approval = lowApproval(plan);
  for (const [id, caseId, tokens] of [["deepseek", "patterns", 2048], ["minimax", "entry", 2048], ["minimax", "confusables", 2048], ["minimax", "patterns", 8192]]) {
    assert.throws(() => reserveAttempt(plan, ledger, id, caseId, 2000, tokens, approval), code("followup_request_bounds"));
  }
  plan.providers.minimax.maximumCost = ledger.providers.minimax.reservedMicros / 1e6;
  assert.throws(() => reserveAttempt(plan, ledger, "minimax", "patterns", 2000, 2048, approval), code("cost_budget_exhausted"));
  assert.equal(ledger.providers.minimax.attempts.length, 4);
});

test("the plan runs the redesigned usage points and no longer the collocations-with-topic step", () => {
  const plan = buildPlan(PUBLIC);
  assert.deepEqual(plan.cases, ["entry", "patterns", "confusables"]);
  assert.equal(Object.hasOwn(plan.data, "topic"), false);
  for (const cases of [["collocations"], ["entry", "collocations"]]) {
    assert.throws(() => validateApproval(plan, { ...approved(plan), cases }), code("approval_required_or_mismatched"));
  }
  const ledger = newLedger(plan);
  assert.throws(() => reserveAttempt(plan, ledger, "deepseek", "collocations", 2000, 2048), code("request_bounds"));
  ledger.providers.deepseek.attempts.push({ caseId: "collocations", reservedMicros: 0 });
  assert.throws(() => validateLedger(plan, ledger), code("ledger_invalid"));
});
test("public plan keeps the four exact approved models and states the Gemini protocol limitation", () => {
  const plan = buildPlan(PUBLIC);
  assert.equal(plan.providers.gemini.productionProvider, "custom");
  assert.match(plan.boundaries.gemini, /does not test the native/);
  assert.equal(plan.providers.minimax.baseUrl, "https://api.minimax.cn/v1");
  assert.equal(plan.providers.deepseek.keyVariable, "DEEPSEEK_API_KEY");
  assert.deepEqual(plan.boundaries.openrouterCostDifference, { provider: { max_price: { prompt: 2, completion: 10, request: 0 } } });
  assert.match(plan.boundaries.inheritedProviderEnvironment, /ignored/);
});
test("unexpected model and unsafe endpoints are refused before any secret access", () => {
  assert.throws(() => buildPlan(PUBLIC.replace("deepseek-flash", "unapproved-model")), code("public_model_changed_DEEPSEEK"));
  for (const url of ["http://api.deepseek.com", "https://user:pass@api.deepseek.com", "https://api.deepseek.com?key=secret", "https://api.deepseek.com#x"]) {
    assert.throws(() => buildPlan(PUBLIC.replace("https://api.deepseek.com", JSON.stringify(url))), code("public_endpoint_invalid"));
  }
});
test("approval binds public configuration, providers, cases and diagnostic output changes", () => {
  const plan = buildPlan(PUBLIC), value = approved(plan);
  assert.equal(validateApproval(plan, value), value);
  for (const patch of [{ authorized: false }, { planHash: "different" }, { providers: ["unknown"] }, { cases: ["literature"] },
    { authorizationReference: "" }, { diagnosticOutputTokens: 9000 }, { retryFailed: undefined }, { providers: ["deepseek", "deepseek"] }]) {
    assert.throws(() => validateApproval(plan, { ...value, ...patch }), code("approval_required_or_mismatched"));
  }
  assert.equal(validateApproval(plan, { ...value, diagnosticOutputTokens: 8192 }).diagnosticOutputTokens, 8192);
});
test("fixed prices are usable only on the verification UTC day without changing the plan", () => {
  const plan = buildPlan(PUBLIC), original = JSON.stringify(plan);
  for (const time of ["2026-10-25T00:00:00.000Z", "2026-10-25T23:59:59.999Z"]) {
    assert.equal(validatePriceFreshness(plan, Date.parse(time)), true);
  }
  for (const time of [Date.parse("2026-10-24T23:59:59.999Z"), Date.parse("2026-10-26T00:00:00.000Z"),
    Date.parse("2027-01-01T00:00:00Z"), NaN, Infinity, 1e20]) {
    assert.throws(() => validatePriceFreshness(plan, time), code("price_verification_expired"));
  }
  assert.equal(JSON.stringify(plan), original);
});
test("scope and every provider price must match the same verified day", () => {
  const time = Date.parse("2026-10-25T12:00:00Z"), plan = buildPlan(PUBLIC);
  assert.throws(() => validatePriceFreshness({ ...plan, scope: "dictionary-four-provider-2026-10-24" }, time), code("price_verification_expired"));
  assert.throws(() => validatePriceFreshness({ ...plan, providers: {} }, time), code("price_verification_expired"));
  for (const priceVerifiedAt of ["2026-10-24", "2026-10-26", "2026-10-25T00:00:00Z", undefined]) {
    const changed = structuredClone(plan); changed.providers.gemini.priceVerifiedAt = priceVerifiedAt;
    assert.throws(() => validatePriceFreshness(changed, time), code("price_verification_expired"));
  }
});
test("HTTP requests and conservative money reservations persist across restart", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dict-live-ledger-test-"));
  try {
    const plan = buildPlan(PUBLIC), ledger = newLedger(plan), file = resolve(dir, "ledger.json");
    reserveAttempt(plan, ledger, "deepseek", "entry", 2000, 3072);
    reserveAttempt(plan, ledger, "deepseek", "entry", 2000, 3072);
    const spent = ledger.providers.deepseek.reservedMicros;
    writeFileSync(file, JSON.stringify(ledger));
    const restarted = validateLedger(plan, JSON.parse(readFileSync(file, "utf8")));
    assert.equal(restarted.providers.deepseek.reservedMicros, spent);
    assert.throws(() => reserveAttempt(plan, restarted, "deepseek", "entry", 2000, 3072), code("request_budget_exhausted"));
    reserveAttempt(plan, restarted, "deepseek", "patterns", 3000, 2048);
    reserveAttempt(plan, restarted, "deepseek", "confusables", 3000, 2048);
    assert.equal(restarted.providers.deepseek.attempts.length, 4);
    // The provider cap holds even though confusables has one per-case request left.
    assert.throws(() => reserveAttempt(plan, restarted, "deepseek", "confusables", 3000, 2048), code("request_budget_exhausted"));
    assert.ok(restarted.providers.deepseek.reservedMicros > spent);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a failed or uncertain dispatch is still charged against the local budget", () => {
  const plan = buildPlan(PUBLIC), ledger = newLedger(plan);
  const first = reserveAttempt(plan, ledger, "minimax", "entry", 24576, 8192);
  first.state = "failed_or_uncertain";
  const reserved = ledger.providers.minimax.reservedMicros;
  const restarted = validateLedger(plan, JSON.parse(JSON.stringify(ledger)));
  assert.equal(restarted.providers.minimax.reservedMicros, reserved);
  reserveAttempt(plan, restarted, "minimax", "entry", 24576, 8192);
  assert.throws(() => reserveAttempt(plan, restarted, "minimax", "entry", 10, 1), code("request_budget_exhausted"));
});
test("input/output/cost limits fail closed without consuming an unissued request", () => {
  const plan = buildPlan(PUBLIC), ledger = newLedger(plan);
  for (const [bytes, tokens] of [[24577, 1], [1, 8193], [0, 1], [1, 0], [1.5, 1]]) {
    assert.throws(() => reserveAttempt(plan, ledger, "deepseek", "entry", bytes, tokens), code("request_bounds"));
  }
  plan.providers.deepseek.maximumCost = .00001;
  assert.throws(() => reserveAttempt(plan, ledger, "deepseek", "entry", 1000, 3072), code("cost_budget_exhausted"));
  assert.equal(ledger.providers.deepseek.attempts.length, 0);
  assert.equal(ledger.providers.deepseek.reservedMicros, 0);
});
test("ledger corruption or changed plan cannot reset accounting", () => {
  const plan = buildPlan(PUBLIC), ledger = newLedger(plan);
  assert.throws(() => validateLedger(plan, { ...ledger, planHash: "changed" }), code("ledger_plan_mismatch"));
  ledger.providers.deepseek.reservedMicros = -1;
  assert.throws(() => validateLedger(plan, ledger), code("ledger_invalid"));
  ledger.providers.deepseek.reservedMicros = 1;
  assert.throws(() => validateLedger(plan, ledger), code("ledger_invalid"));
});
test("bounded reservations keep all four providers below their separate currency caps", () => {
  const plan = buildPlan(PUBLIC), ledger = newLedger(plan);
  for (const [id, config] of Object.entries(plan.providers)) {
    for (const caseId of ["entry", "patterns", "confusables", "patterns"]) reserveAttempt(plan, ledger, id, caseId, 24576, 8192);
    assert.ok(ledger.providers[id].reservedMicros <= config.maximumCost * 1e6);
  }
  assert.equal(plan.providers.minimax.currency, "CNY");
  assert.equal(plan.providers.openrouter.currency, "USD");
});
test("completion diagnostics retain finish reason and reasoning usage without response text", () => {
  const info = completionMetadata({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "PRIVATE_REASONING" } }],
    usage: { prompt_tokens: 100, completion_tokens: 3072, total_tokens: 3172, completion_tokens_details: { reasoning_tokens: 3072 }, arbitrary: "PRIVATE" } });
  assert.equal(info.finishReason, "length"); assert.equal(info.contentEmpty, true);
  assert.equal(info.usage["completion_tokens_details.reasoning_tokens"], 3072);
  assert.equal(info.reasoningContentLength, 17);
  assert.ok(!JSON.stringify(info).includes("PRIVATE"));
});
test("reports redact full selected credentials and bearer-shaped content without fingerprints", () => {
  const secret = "synthetic-key-value-only", text = redactText(secret + " / Bearer other-sensitive-value / sk-example_fixture_value", [secret]);
  assert.ok(!text.includes(secret)); assert.ok(!text.includes("other-sensitive-value"));
  assert.ok(!text.includes("example_fixture_value")); assert.match(text, /REDACTED/);
});
test("diagnostic answer reports exclude reasoning and provider error fields while redacting content", () => {
  const secret = "synthetic-fixture-key-value";
  const body = { error: { message: "PRIVATE_ERROR" }, choices: [{ finish_reason: "stop", message: {
    content: "Generated example " + secret, reasoning_content: "PRIVATE_REASONING"
  } }] };
  const report = completionReport(body, [secret]), serialized = JSON.stringify(report);
  assert.match(report.content, /Generated example \[REDACTED\]/);
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes("PRIVATE_"));
  assert.equal(completionReport({ error: { message: "PRIVATE_ERROR" } }), null);
});
// Handwritten chat.completion.chunk wire bodies (OpenAI streaming reference),
// written here as literal text, not by the rehearsal fixture's writer.
const SSE_ANSWER = ': OPENROUTER PROCESSING\r\n\r\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_content":"PRIVATE_REASONING","reasoning":"PRIVATE_REASONING"},"finish_reason":null}]}\n\n' +
  'event: message\nid: 7\ndata: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"{\\"word\\":\\"pro"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"vider\\"}"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40,"total_tokens":140,"completion_tokens_details":{"reasoning_tokens":12}}}\n\n' +
  'data: [DONE]\n\n';
test("a streamed answer is folded into the same diagnostics without keeping reasoning text", () => {
  const body = streamCompletion(SSE_ANSWER), info = completionMetadata(body);
  assert.equal(body.choices[0].message.content, '{"word":"provider"}');
  assert.equal(info.finishReason, "stop"); assert.equal(info.contentEmpty, false); assert.equal(info.contentLength, 19);
  // reasoning_content and its alias reasoning arrive together: counted once.
  assert.equal(info.reasoningContentLength, 17);
  assert.equal(info.usage.completion_tokens, 40); assert.equal(info.usage["completion_tokens_details.reasoning_tokens"], 12);
  assert.ok(!JSON.stringify(info).includes("PRIVATE"));
  const report = completionReport(body, []);
  assert.equal(report.content, '{"word":"provider"}'); assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});
test("streamed truncation, in-stream errors and broken framing stay visible as such", () => {
  const cut = streamCompletion('data: {"choices":[{"index":0,"delta":{"content":"{\\"word"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  assert.equal(completionMetadata(cut).finishReason, "length");
  const thinkingOnly = streamCompletion('data: {"choices":[{"index":0,"delta":{"reasoning":"PRIVATE_REASONING"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n');
  assert.equal(completionMetadata(thinkingOnly).contentEmpty, true); assert.equal(completionReport(thinkingOnly), null);
  const failed = streamCompletion('data: {"error":{"message":"PRIVATE_ERROR","code":500}}\n\n');
  assert.ok(failed.error); assert.ok(!JSON.stringify(failed).includes("PRIVATE_ERROR"));
  assert.equal(completionMetadata(failed).finishReason, "other_or_missing");
  assert.equal(streamCompletion('data: {"choices":[{"delta":{"content":"x"}\n\n'), null);
  assert.equal(streamCompletion(": keep-alive\n\ndata: [DONE]\n\n"), null);
  assert.equal(streamCompletion(""), null);
});
test("the replayed content type follows the answer: SSE for a streamed 2xx, JSON for an HTTP error", () => {
  assert.deepEqual(readAnswerBody(SSE_ANSWER, true, "text/event-stream; charset=utf-8").contentType, "text/event-stream");
  assert.equal(readAnswerBody(SSE_ANSWER, true, "").streamed, true);
  const error = readAnswerBody('{"error":{"message":"bad request"}}', false, "application/json");
  assert.equal(error.streamed, false); assert.equal(error.contentType, "application/json"); assert.equal(error.parsed.error.message, "bad request");
  // A 4xx/5xx is never parsed as a stream, whatever it claims to be.
  assert.equal(readAnswerBody("data: {}\n\n", false, "text/event-stream").streamed, false);
});
test("only the product's own streamed request is admitted", () => {
  const body = patch => ({ model: "m", stream: true, messages: [{ role: "user", content: "Create a concise reusable dictionary entry\n{}" }],
    max_completion_tokens: 8192, ...patch });
  assert.equal(isProductRequest(body(), "m"), true);
  for (const value of [body({ stream: undefined }), body({ stream: false }), body({ stream: "true" }), body({ stream_options: { include_usage: true } }),
    body({ model: "other" }), body({ tools: [] }), body({ tool_choice: "auto" }), body({ messages: [] }),
    body({ messages: [{ role: "system", content: "x" }] }), null]) assert.equal(isProductRequest(value, "m"), false, JSON.stringify(value));
});
test("--plan and rejected approval never read or probe .env and never use network", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dict-live-plan-test-"));
  try {
    writeFileSync(resolve(dir, "providers.env"), PUBLIC);
    const hook = resolve(dir, "guard.mjs");
    const guard = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      for (const name of ['readFileSync','statSync','existsSync','openSync']) { const original=fs[name]; fs[name]=function(path,...args){if(String(path).endsWith('/.env'))throw new Error('FORBIDDEN_SECRET_ACCESS');return original.call(this,path,...args);}; }
      syncBuiltinESMExports(); globalThis.fetch=()=>{throw new Error('FORBIDDEN_NETWORK');};`;
    writeFileSync(hook, guard + `Date.now=()=>Date.parse('2026-10-25T12:00:00Z');`);
    const runner = resolve("scripts/dict-live-test.mjs"), args = ["--import", hook, runner, "--config-dir", dir];
    const dry = spawnSync(process.execPath, [...args, "--plan"], { encoding: "utf8" });
    assert.equal(dry.error?.code, undefined, "local subprocess could not start");
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout); assert.equal(report.approvalTemplate.authorized, false);
    const approval = resolve(dir, "approval.json"); writeFileSync(approval, JSON.stringify({ ...report.approvalTemplate, authorized: false }));
    const denied = spawnSync(process.execPath, [...args, "--live", "--approval", approval], { encoding: "utf8" });
    assert.equal(denied.error?.code, undefined, "local subprocess could not start");
    assert.equal(denied.status, 1); assert.match(denied.stderr, /approval_required_or_mismatched/);
    assert.ok(!denied.stderr.includes("FORBIDDEN"));
    // Price expiry must win even before approval validation, and before any
    // secret access. This is an intentionally unapproved, network-blocked run.
    writeFileSync(hook, guard + `Date.now=()=>Date.parse('2026-10-26T00:00:00Z');`);
    const expired = spawnSync(process.execPath, [...args, "--live", "--approval", approval], { encoding: "utf8" });
    assert.equal(expired.error?.code, undefined, "local subprocess could not start");
    assert.equal(expired.status, 1); assert.match(expired.stderr, /price_verification_expired/);
    assert.ok(!expired.stderr.includes("FORBIDDEN"));
    const laterPlan = spawnSync(process.execPath, [...args, "--plan"], { encoding: "utf8" });
    assert.equal(laterPlan.error?.code, undefined, "local subprocess could not start");
    assert.equal(laterPlan.status, 0); assert.equal(JSON.parse(laterPlan.stdout).plan.planHash, report.plan.planHash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
