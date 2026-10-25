import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { makePlan, MODELS, CASES, validateApproval, newLedger, reserve, boundedBody, verifyGatewayMetadata, verifyReturnedUsage, reusableEntries, requestInputBytes, httpErrorMetadata } from "../scripts/dict-litellm-test.mjs";
// Handwritten ai-dev command output schema, independent of production pricing.
const estimates = Object.fromEntries(MODELS.map(model => [model.alias, {
  snapshot: { fetched_at: 1792930375, stale: false, currency: "USD" },
  result: { status: "estimated", model: model.provider + "/" + model.model, provider: model.provider,
    requests: 12, input_tokens: 25600, output_tokens: 8192, total_usd: "0.08",
    rates_usd_per_million_tokens: { input_cost_per_token: "0.10", output_cost_per_token: "0.20" } }
}]));
const plan = makePlan(estimates, "2026-10-25T15:00:00.000Z"), alias = MODELS[0].alias;
const now = Date.parse("2026-10-25T16:00:00.000Z");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
test("non-success diagnostics contain only fixed capability labels, never echoed input or secrets", () => {
  const value = httpErrorMetadata({ error: { message: "PRIVATE_ECHO response_format: unknown variant 'json_schema', expected 'json_object'", type: "PRIVATE_TYPE", code: "PRIVATE_CODE", key: "PRIVATE_KEY" } });
  assert.deepEqual(value, { mentionedParameters: ["response_format", "json_schema", "json_object"], formatEnumRefusal: true });
  assert(!JSON.stringify(value).includes("PRIVATE"));
  assert.equal(httpErrorMetadata({ error: { message: "response_format: Invalid schema, required must be an array" } }).formatEnumRefusal, false);
});
test("schema and framing bytes count against the same approved input budget", () => {
  const body = { messages: [{ role: "user", content: "合成资料" }] };
  const plain = requestInputBytes(body);
  body.response_format = { type: "json_schema", json_schema: { name: "response", strict: true,
    schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] } } };
  assert(requestInputBytes(body) > plain + Buffer.byteLength(JSON.stringify(body.response_format)));
  body.messages[0].content = "x".repeat(24500);
  assert.throws(() => reserve(plan, newLedger(plan), alias, "provider-entry", requestInputBytes(body), 2048), /request_bounds/);
  body.response_format.json_schema.strict = false;
  assert.throws(() => requestInputBytes(body), /request_shape/);
});
test("all aliases share nine cases, with no decision model or provider business policy", () => {
  assert.equal(plan.models.length, 7); assert.equal(plan.cases.length, 9);
  assert(!plan.models.some(row => /decision/.test(row.alias)));
  assert.deepEqual(new Set(CASES.filter(row => row.kind !== "entry").map(row => row.kind)),
    new Set(["collocations", "confusables", "register", "grammar", "scenarios", "literature", "culture"]));
});
test("unknown, expired or mismatched ai-dev quotes stop preparation", () => {
  for (const edit of [row => row.result.status = "unknown", row => row.snapshot.stale = true,
    row => row.result.provider = "other", row => row.result.total_usd = "10", row => row.result.output_tokens = 9000]) {
    const copy = structuredClone(estimates); edit(copy[alias]); assert.throws(() => makePlan(copy));
  }
});
test("generic task approval or a different plan never authorizes live calls", () => {
  for (const approval of [undefined, {}, { authorized: true }, { authorized: true, planHash: "different" }])
    assert.throws(() => validateApproval(plan, approval, now));
});
test("concrete approval covers the exact plan and evidence, with expiring prices", () => {
  const evidence = { "provider:literature": { ok: true, sources: [] } };
  const approval = { authorized: true, planHash: plan.planHash, authorizationReference: "test-user-approval",
    allowDiagnosticRecheck: true, evidence, evidenceHash: hash(evidence) };
  assert.equal(validateApproval(plan, approval, now), approval);
  assert.throws(() => validateApproval(plan, approval, now + 26 * 3600000), /price_expired/);
  const copy = structuredClone(plan); copy.models[0].cap = 100;
  assert.throws(() => validateApproval(copy, approval, now), /specific_approval_required/);
  assert.throws(() => validateApproval(plan, { ...approval, evidence: {} }, now), /specific_approval_required/);
});
test("gateway metadata must match the intended route and verified price bound", () => {
  const data = { data: [{ model_name: alias, litellm_params: { model: "deepseek/deepseek-flash" },
    model_info: { input_cost_per_token: .0000001, output_cost_per_token: .0000002 } }] };
  assert.deepEqual(verifyGatewayMetadata(plan, data, [alias]), [{ model: alias, provider: "deepseek", priceWithinPlan: true }]);
  const bare = structuredClone(data); bare.data[0].litellm_params.model = "deepseek-flash";
  assert.throws(() => verifyGatewayMetadata(plan, bare, [alias]), /gateway_route_unverified/);
  bare.data[0].model_info.litellm_provider = "deepseek";
  assert.equal(verifyGatewayMetadata(plan, bare, [alias]).length, 1);
  for (const edit of [row => row.data.push(structuredClone(row.data[0])), row => row.data[0].litellm_params.model = "other/paid-model",
    row => delete row.data[0].model_info, row => row.data[0].model_info.output_cost_per_token = 1]) {
    const copy = structuredClone(data); edit(copy); assert.throws(() => verifyGatewayMetadata(plan, copy, [alias]));
  }
});
test("equivalent per-token and per-million decimal prices are not different rates", () => {
  const copy = structuredClone(plan); copy.models[0].output = .47;
  const data = { data: [{ model_name: alias, litellm_params: { model: "deepseek/deepseek-flash" },
    model_info: { input_cost_per_token: .0000001, output_cost_per_token: .00000047 } }] };
  assert.equal(verifyGatewayMetadata(copy, data, [alias]).length, 1);
  data.data[0].model_info.output_cost_per_token = .000000471;
  assert.throws(() => verifyGatewayMetadata(copy, data, [alias]), /gateway_price_unverified/);
});
test("each dispatch reserves before receiving an answer; failures do not refund", () => {
  const ledger = newLedger(plan); const a = reserve(plan, ledger, alias, CASES[0].id, 1024, 2048);
  a.state = "failed_or_uncertain";
  reserve(plan, ledger, alias, CASES[0].id, 1024, 2048);
  assert.throws(() => reserve(plan, ledger, alias, CASES[0].id, 1024, 2048), /request_limit/);
  assert.equal(ledger.models[alias].reservedMicros, a.reservedMicros * 2);
});
test("reported output includes reasoning and cannot silently exceed the request reservation", () => {
  const attempt = { outputTokens: 3072, inputBytes: 1000, usage: { prompt_tokens: 500, completion_tokens: 3338, "completion_tokens_details.reasoning_tokens": 2244 } };
  assert.throws(() => verifyReturnedUsage(attempt), /gateway_output_limit_exceeded/);
  attempt.outputTokens = 8192; verifyReturnedUsage(attempt);
  attempt.usage.prompt_tokens = 2025;
  assert.throws(() => verifyReturnedUsage(attempt), /gateway_input_limit_exceeded/);
});
test("saved synthetic entries can seed supplements but never replace a failed entry test", () => {
  const ledger = newLedger(plan);
  ledger.models[alias].cases['provider-entry'] = { ok: true, value: { word: 'provider', language: 'en' } };
  assert.equal(reusableEntries(ledger, alias, ['provider-grammar'])[0].model, alias);
  assert.throws(() => reusableEntries(ledger, alias, ['provider-entry']), /reuse_only_for_supplements/);
  assert.throws(() => reusableEntries(ledger, alias, ['based-culture']), /reused_entry_unverified/);
  ledger.models[alias].cases['provider-entry'].ok = false;
  assert.throws(() => reusableEntries(ledger, alias, ['provider-grammar']), /reused_entry_unverified/);
});
test("the twelve-call model cap includes compatibility attempts across cases", () => {
  const ledger = newLedger(plan);
  for (let i = 0; i < 12; i++) reserve(plan, ledger, alias, CASES[i % CASES.length].id, 50, 50);
  assert.throws(() => reserve(plan, ledger, alias, CASES[4].id, 50, 50), /request_limit/);
});
test("bounds cannot be bypassed with fractional, negative, infinite or oversized inputs", () => {
  for (const bytes of [0, -1, NaN, Infinity, 1.5, 24577]) assert.throws(() => reserve(plan, newLedger(plan), alias, CASES[0].id, bytes, 2048));
  for (const tokens of [0, -1, NaN, Infinity, 1.5, 8193]) assert.throws(() => reserve(plan, newLedger(plan), alias, CASES[0].id, 1000, tokens));
});
test("tampered totals and monetary overruns fail before dispatch", () => {
  const ledger = newLedger(plan); ledger.models[alias].reservedMicros = 1;
  assert.throws(() => reserve(plan, ledger, alias, CASES[0].id, 1000, 2048), /ledger_invalid/);
  const small = structuredClone(plan); small.models[0].cap = .000001;
  assert.throws(() => reserve(small, newLedger(small), alias, CASES[0].id, 1000, 2048), /cost_limit/);
});
test("a chunked response has a byte bound, not just a content-length check", async () => {
  assert.equal(await boundedBody(new Response("short"), 5), "short");
  await assert.rejects(boundedBody(new Response("sixsix"), 5), /response_too_large/);
});
