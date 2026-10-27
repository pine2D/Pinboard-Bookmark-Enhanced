// Guard tests for the revised comparison driver (redesign plan 1B.9). Pure
// functions only: no browser, no network, no credential file. Request bodies
// are handwritten in the shape the product sends; nothing is built by the
// driver's own constructors.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateConfig, checkBaseUrl, makePlan, plannedCases, validateApproval, validatePriceFreshness, newLedger, validateLedger,
  reserve, settle, authorizeRequest, wikimediaAllowed, resumeGuard, outcomeOf, summarize, readKey, verifyProduct,
  PRODUCT_FINGERPRINT, ARMS, WORDS, LIMITS, SELECTORS, BLOCK_OF, REHEARSAL_CONFIG, DRIVER_FILES } from "../scripts/dict-redesign-test-r2.mjs";

const code = expected => error => error.safeCode === expected;
const fingerprints = { product: "a".repeat(64), driver: "b".repeat(64) };
const config = (patch = {}) => ({ schema: 1, endpoint: "https://gateway.example.test/v1", keyVariable: "GATEWAY_API_KEY", currency: "USD",
  totalCap: 2, models: [
    { id: "vendor/model-one", cap: 1, inputPerMillion: 1, outputPerMillion: 4, priceSource: "ai-dev prices", priceVerifiedAt: "2026-10-27" },
    { id: "vendor/model-two", cap: 0.5, inputPerMillion: 0.5, outputPerMillion: 2, priceSource: "ai-dev prices", priceVerifiedAt: "2026-10-27" }],
  words: ["charge", "bekommen"], ...patch });
const plan = makePlan(config(), fingerprints);
const caseOf = (arm, wordId = "charge", model = "vendor/model-one") => ({ caseId: [model, wordId, arm].join(":"), model, wordId, arm });
const target = lang => ({ lang, name: lang === "en" ? "English" : "Simplified Chinese" });
const baseEntry = { word: "charge", language: "en", meanings: [{ partOfSpeech: "名词", definition: "费用。" }] };
// Handwritten in the product's request shape: prompt text, then the JSON
// payload line. Generation streams (plan 2.7), so the body carries stream:true.
const body = (opening, payload, patch = {}) => ({ model: "vendor/model-one", messages: [{ role: "user", content: opening + " Instructions.\n" + JSON.stringify(payload) }],
  temperature: 0.2, response_format: { type: "json_object" }, max_tokens: 8192, stream: true, ...patch });
const entryBody = (patch, payloadPatch = {}) => body("Create a concise reusable dictionary entry for a language learner.",
  { term: "charge", sourceLanguage: "en", targetLanguage: target("zh-Hans"), ...payloadPatch }, patch);
const patternsBody = (payloadPatch = {}) => body("Create one compact usage card for a language learner.",
  { task: "usage-card", term: "charge", sourceLanguage: "en", targetLanguage: target("zh-Hans"), nativeLanguage: "Simplified Chinese", baseEntry, ...payloadPatch });
const supplementBody = (category, payloadPatch = {}) => body("Create a concise language-learning supplement.",
  { category, term: "charge", sourceLanguage: "en", targetLanguage: target("zh-Hans"), profile: { nativeLanguage: "Simplified Chinese", level: "intermediate" },
    baseEntry, sources: [], ...payloadPatch });

test("the run configuration keeps the endpoint, models, prices and caps configurable but bounded", () => {
  const value = validateConfig(config());
  assert.equal(value.endpoint, "https://gateway.example.test/v1");
  assert.deepEqual(value.arms, ARMS);
  assert.deepEqual(validateConfig(config({ words: undefined })).words, WORDS.map(word => word.id));
  assert.equal(validateConfig(config({ endpoint: "http://127.0.0.1:48097/v1/" })).endpoint, "http://127.0.0.1:48097/v1");
  for (const endpoint of ["http://192.168.1.5:4000/v1", "http://gateway.example.test/v1", "https://user:pw@gateway.example.test/v1",
    "https://gateway.example.test/v1?key=x", "https://gateway.example.test/v1#x", "not a url"]) {
    assert.throws(() => validateConfig(config({ endpoint })), error => ["endpoint_policy", "endpoint_invalid"].includes(error.safeCode), endpoint);
  }
  const refusals = [[{ extra: true }, "config_invalid"], [{ schema: 2 }, "config_invalid"], [{ keyVariable: "gateway_key" }, "config_key_variable"],
    [{ currency: "EUR" }, "config_currency"], [{ totalCap: 0 }, "config_total_cap"], [{ models: [] }, "config_models"],
    [{ words: ["provider"] }, "config_words"], [{ words: ["charge", "charge"] }, "config_words"],
    [{ arms: ["patterns"] }, "config_arms"], [{ arms: ["entry", "collocations"] }, "config_arms"], [{ arms: ["entry", "scenarios"] }, "config_arms"]];
  for (const [patch, expected] of refusals) assert.throws(() => validateConfig(config(patch)), code(expected), JSON.stringify(patch));
  const model = config().models[0];
  for (const [patch, expected] of [[{ cap: 3 }, "config_model_price"], [{ outputPerMillion: 0 }, "config_model_price"], [{ id: "bad model" }, "config_model_id"],
    [{ priceVerifiedAt: "today" }, "config_model_price_source"], [{ priceSource: " " }, "config_model_price_source"], [{ extra: 1 }, "config_model_fields"]]) {
    assert.throws(() => validateConfig(config({ models: [{ ...model, ...patch }] })), code(expected), JSON.stringify(patch));
  }
  const { priceSource, ...missing } = model;
  assert.throws(() => validateConfig(config({ models: [missing] })), code("config_model_fields"));
  assert.throws(() => validateConfig(config({ models: [model, model] })), code("config_models"));
  assert.equal(checkBaseUrl("https://x.test/v1///"), "https://x.test/v1");
});

test("the plan drives the redesigned arms in order and binds configuration and code", () => {
  assert.deepEqual(plan.arms, ["entry", "patterns", "confusables", "etymology"]);
  assert.deepEqual(BLOCK_OF, { patterns: "usage", confusables: "usage", etymology: "etymology" });
  const cases = plannedCases(plan);
  assert.equal(cases.length, 2 * 2 * 4);
  assert.deepEqual(cases.slice(0, 4).map(item => item.arm), ARMS);
  assert.ok(!cases.some(item => ["collocations", "register", "grammar", "scenarios", "culture", "literature"].includes(item.arm)));
  assert.equal(plan.selectors.generate, ".xp-dict-supplement-generate");
  assert.equal(SELECTORS.block, "[data-learning-block]");
  assert.equal(plan.limits.outputTokens, 8192); assert.equal(plan.limits.retries, 0);
  for (const changed of [makePlan(config({ endpoint: "https://other.example.test/v1" }), fingerprints),
    makePlan(config(), { ...fingerprints, product: "c".repeat(64) }), makePlan(config(), { ...fingerprints, driver: "c".repeat(64) }),
    makePlan(config({ models: [{ ...config().models[0], outputPerMillion: 5 }] }), fingerprints)]) {
    assert.notEqual(changed.planHash, plan.planHash);
  }
  assert.throws(() => makePlan(config(), { product: "p", driver: "d" }), code("fingerprints_invalid"));
  assert.deepEqual(DRIVER_FILES, ["scripts/dict-redesign-test-r2.mjs", "scripts/dict-live-test.mjs", "scripts/dict-litellm-test.mjs"]);
  assert.match(JSON.stringify(plan.sent), /test word/);
  assert.doesNotMatch(JSON.stringify(plan.sent), /article|vocabulary|Ask/i);
});

test("the product pin is one reviewed fingerprint and any other product refuses", () => {
  assert.match(PRODUCT_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(verifyProduct(PRODUCT_FINGERPRINT), true);
  for (const value of ["0".repeat(64), "", undefined]) assert.throws(() => verifyProduct(value), code("product_changed"));
});

test("approval binds the plan hash, a reference and a subset of the planned models", () => {
  const value = { authorized: true, planHash: plan.planHash, authorizationReference: "synthetic-unit-fixture", models: ["vendor/model-two"] };
  assert.equal(validateApproval(plan, value), value);
  for (const patch of [{ authorized: false }, { authorized: "true" }, { planHash: "other" }, { authorizationReference: "" }, { models: [] },
    { models: ["vendor/model-three"] }, { models: ["vendor/model-two", "vendor/model-two"] }]) {
    assert.throws(() => validateApproval(plan, { ...value, ...patch }), code("approval_required_or_mismatched"), JSON.stringify(patch));
  }
  assert.throws(() => validateApproval(plan, null), code("approval_required_or_mismatched"));
});

test("prices are valid only on their verification UTC day", () => {
  for (const time of ["2026-10-27T00:00:00Z", "2026-10-27T23:59:59.999Z"]) assert.equal(validatePriceFreshness(plan, Date.parse(time)), true);
  for (const time of [Date.parse("2026-10-26T23:59:59.999Z"), Date.parse("2026-10-28T00:00:00Z"), NaN, Infinity, 1e20]) {
    assert.throws(() => validatePriceFreshness(plan, time), code("price_verification_expired"));
  }
  const mixed = makePlan(config({ models: [config().models[0], { ...config().models[1], priceVerifiedAt: "2026-10-26" }] }), fingerprints);
  assert.throws(() => validatePriceFreshness(mixed, Date.parse("2026-10-27T12:00:00Z")), code("price_verification_expired"));
});

test("reservations are never refunded and stop at the per-click, per-model and total caps", () => {
  const ledger = newLedger(plan), entry = caseOf("entry").caseId;
  for (let i = 0; i < LIMITS.httpPerCase; i++) reserve(plan, ledger, { model: "vendor/model-one", caseId: entry, inputBytes: 2000, outputTokens: 8192 });
  assert.throws(() => reserve(plan, ledger, { model: "vendor/model-one", caseId: entry, inputBytes: 10, outputTokens: 1 }), code("request_limit"));
  const restarted = validateLedger(plan, JSON.parse(JSON.stringify(ledger)));
  assert.equal(restarted.reservedMicros, ledger.models["vendor/model-one"].reservedMicros);
  assert.throws(() => reserve(plan, restarted, { model: "vendor/model-one", caseId: entry, inputBytes: 10, outputTokens: 1 }), code("request_limit"));
  // Worst case per request: (24576 + 1024) * 1 + 8192 * 4 = 58368 micro-USD.
  const capped = newLedger(plan);
  const arms = ["patterns", "confusables", "etymology"].flatMap(arm => [caseOf(arm), caseOf(arm, "bekommen")]).map(item => item.caseId);
  let count = 0;
  assert.throws(() => { for (const caseId of [...arms, ...arms, ...arms, ...arms]) { reserve(plan, capped, { model: "vendor/model-one", caseId, inputBytes: 24576, outputTokens: 8192 }); count++; } },
    code("cost_limit_model"));
  assert.equal(count, Math.floor(1e6 / 58368));
  const tight = makePlan(config({ totalCap: 0.06, models: [{ ...config().models[0], cap: 0.06 }, { ...config().models[1], cap: 0.06 }] }), fingerprints);
  const total = newLedger(tight);
  reserve(tight, total, { model: "vendor/model-one", caseId: caseOf("entry").caseId, inputBytes: 24576, outputTokens: 8192 });
  assert.throws(() => reserve(tight, total, { model: "vendor/model-two", caseId: caseOf("entry", "charge", "vendor/model-two").caseId, inputBytes: 24576, outputTokens: 8192 }),
    code("cost_limit_total"));
  for (const [patch, expected] of [[{ inputBytes: 24577 }, "request_bounds"], [{ outputTokens: 8193 }, "request_bounds"], [{ inputBytes: 0 }, "request_bounds"],
    [{ caseId: "vendor/model-one:charge:collocations" }, "request_bounds"], [{ model: "vendor/model-three" }, "request_bounds"],
    [{ caseId: caseOf("entry", "charge", "vendor/model-two").caseId }, "request_bounds"]]) {
    const fresh = newLedger(plan);
    assert.throws(() => reserve(plan, fresh, { model: "vendor/model-one", caseId: entry, inputBytes: 100, outputTokens: 100, ...patch }), code(expected), JSON.stringify(patch));
    assert.equal(fresh.reservedMicros, 0);
  }
});

test("a tampered or foreign ledger cannot reset the accounting", () => {
  const ledger = newLedger(plan);
  reserve(plan, ledger, { model: "vendor/model-one", caseId: caseOf("entry").caseId, inputBytes: 100, outputTokens: 100 });
  assert.throws(() => validateLedger(plan, { ...ledger, planHash: "other" }), code("ledger_plan_mismatch"));
  for (const change of [l => { l.reservedMicros = 0; }, l => { l.models["vendor/model-one"].reservedMicros = 0; },
    l => { l.models["vendor/model-one"].attempts[0].caseId = "vendor/model-one:charge:scenarios"; },
    l => { l.models["vendor/model-one"].cases["vendor/model-one:provider:entry"] = {}; }, l => { delete l.models["vendor/model-two"]; }]) {
    const copy = JSON.parse(JSON.stringify(ledger)); change(copy);
    assert.throws(() => validateLedger(plan, copy), code("ledger_invalid"));
  }
});

test("returned usage above the reservation halts instead of being trusted", () => {
  const ledger = newLedger(plan);
  const attempt = reserve(plan, ledger, { model: "vendor/model-one", caseId: caseOf("entry").caseId, inputBytes: 1000, outputTokens: 4096 });
  assert.equal(settle({ ...attempt }, { prompt_tokens: 900, completion_tokens: 4096, total_tokens: 4996 }).state, "received");
  assert.throws(() => settle({ ...attempt }, { prompt_tokens: 900, completion_tokens: 4000, total_tokens: 9000 }), code("usage_exceeds_reservation"));
  assert.throws(() => settle({ ...attempt }, { prompt_tokens: 3000, completion_tokens: 10 }), code("usage_exceeds_reservation"));
  assert.equal(settle({ ...attempt }, {}).state, "received");
});

test("only the product's own request for the active word and arm is admitted", () => {
  assert.deepEqual(authorizeRequest(plan, caseOf("entry"), entryBody()), { tokens: 8192, field: "max_tokens" });
  const { max_tokens, ...completionTokens } = entryBody({ max_completion_tokens: 4096 });
  assert.deepEqual(authorizeRequest(plan, caseOf("entry"), completionTokens), { tokens: 4096, field: "max_completion_tokens" });
  assert.equal(authorizeRequest(plan, caseOf("patterns"), patternsBody()).tokens, 8192);
  assert.equal(authorizeRequest(plan, caseOf("confusables"), supplementBody("confusables")).tokens, 8192);
  const source = { title: "charge", url: "https://en.wiktionary.org/w/index.php?oldid=1", excerpt: "From Old French." };
  assert.equal(authorizeRequest(plan, caseOf("etymology"), supplementBody("etymology", { sources: [source] })).tokens, 8192);
  const refused = [
    [caseOf("entry"), entryBody({ model: "vendor/model-two" }), "request_shape"],
    [caseOf("entry"), entryBody({ stream: undefined }), "request_shape"],
    [caseOf("entry"), entryBody({ stream: false }), "request_shape"],
    [caseOf("entry"), entryBody({ stream: "true" }), "request_shape"],
    [caseOf("entry"), entryBody({ stream_options: { include_usage: true } }), "request_shape"],
    [caseOf("entry"), entryBody({ tools: [] }), "request_shape"],
    [caseOf("entry"), entryBody({ max_completion_tokens: 10 }), "request_shape"],
    [caseOf("entry"), { ...entryBody(), messages: [...entryBody().messages, { role: "user", content: "x" }] }, "request_shape"],
    [caseOf("entry"), entryBody({ max_tokens: 8193 }), "request_bounds"],
    [caseOf("entry"), entryBody({}, { term: "provider" }), "unauthorized_payload"],
    [caseOf("entry"), entryBody({}, { targetLanguage: target("en") }), "unauthorized_payload"],
    [caseOf("entry"), entryBody({}, { article: "private text" }), "unauthorized_payload"],
    [caseOf("entry", "bekommen"), entryBody(), "unauthorized_payload"],
    [caseOf("patterns"), entryBody(), "unauthorized_payload"],
    [caseOf("patterns"), patternsBody({ task: undefined }), "unauthorized_payload"],
    [caseOf("patterns"), patternsBody({ baseEntry: { ...baseEntry, word: "fee" } }), "unauthorized_payload"],
    [caseOf("confusables"), supplementBody("collocations"), "unauthorized_payload"],
    [caseOf("confusables"), supplementBody("confusables", { sources: [source] }), "unauthorized_payload"],
    [caseOf("etymology"), supplementBody("etymology", { sources: [{ ...source, url: "https://en.wikipedia.org/wiki/Charge" }] }), "unauthorized_payload"],
    [caseOf("etymology"), patternsBody(), "unauthorized_payload"],
    [caseOf("confusables"), { ...supplementBody("confusables"), messages: [{ role: "user", content: "Create a concise language-learning supplement.\nnot json" }] }, "unauthorized_payload"]
  ];
  for (const [testCase, value, expected] of refused) assert.throws(() => authorizeRequest(plan, testCase, value), code(expected), JSON.stringify(value).slice(0, 160));
});

// Each body below is legal for its arm in every field except the prompt
// opening, so only the opening check can refuse it: deleting
// content.startsWith(OPENINGS[...]) from authorizeRequest turns this red.
test("a legal payload under another arm's prompt opening is refused", () => {
  const supplementOpening = "Create a concise language-learning supplement.", cardOpening = "Create one compact usage card for a language learner.";
  const reopen = (value, opening) => ({ ...value, messages: [{ role: "user", content: opening + " Instructions.\n" + value.messages[0].content.split("\n").at(-1) }] });
  const swapped = [
    [caseOf("patterns"), reopen(patternsBody(), supplementOpening)],
    [caseOf("confusables"), reopen(supplementBody("confusables"), cardOpening)],
    [caseOf("etymology"), reopen(supplementBody("etymology"), cardOpening)],
    [caseOf("entry"), reopen(entryBody(), supplementOpening)]
  ];
  for (const [testCase, value] of swapped) {
    assert.throws(() => authorizeRequest(plan, testCase, value), code("unauthorized_payload"), testCase.arm);
    // The same payload under its own opening is admitted, so the refusal above is the opening's alone.
    const own = testCase.arm === "patterns" ? cardOpening : testCase.arm === "entry" ? "Create a concise reusable dictionary entry for a language learner." : supplementOpening;
    assert.equal(authorizeRequest(plan, testCase, reopen(value, own)).tokens, 8192, testCase.arm);
  }
});

test("Wiktionary reads are the word language's exact API path only", () => {
  const charge = WORDS.find(word => word.id === "charge"), davat = WORDS.find(word => word.id === "davat");
  assert.equal(wikimediaAllowed("https://en.wiktionary.org/w/api.php?action=parse&page=charge&format=json", charge), true);
  assert.equal(wikimediaAllowed("https://ru.wiktionary.org/w/api.php?action=query&list=search", davat), true);
  for (const url of ["https://de.wiktionary.org/w/api.php?action=parse", "https://en.wikipedia.org/w/api.php?action=parse",
    "https://en.wiktionary.org/wiki/charge", "https://en.wiktionary.org/w/api.php?action=edit", "http://en.wiktionary.org/w/api.php?action=parse",
    "https://u:p@en.wiktionary.org/w/api.php?action=parse", "not a url"]) assert.equal(wikimediaAllowed(url, charge), false, url);
});

test("outcomes separate success, neutral answers, harness states and product failures", () => {
  const ok = [{ httpStatus: 200 }];
  assert.equal(outcomeOf({ ok: true }, ok).outcome, "success");
  assert.deepEqual(outcomeOf({ ok: false, error: "unsupported_usage" }, ok), { outcome: "neutral", code: "unsupported_usage", reason: "" });
  assert.equal(outcomeOf({ ok: false, error: "control_missing" }, []).outcome, "harness");
  assert.deepEqual(outcomeOf({ ok: false, error: "invalid_response", reason: "supplement_fields" }, ok), { outcome: "failure", code: "invalid_response", reason: "supplement_fields" });
  assert.equal(outcomeOf({ ok: false, archived: true, rendered: false }, ok).code, "render_failed");
  assert.equal(outcomeOf({ ok: false }, ok).code, "save_failed");
  assert.equal(outcomeOf({ ok: false }, [{ httpStatus: 503 }], "transport_timeout").code, "transport_timeout");
  assert.deepEqual(outcomeOf({ ok: false, error: "request_failed" }, [], "cost_limit_model"), { outcome: "blocked", code: "cost_limit_model", reason: "" });
  const row = { cases: {}, attempts: [{ caseId: "x" }] };
  assert.deepEqual(resumeGuard(row, "x"), { outcome: "harness", code: "interrupted", reason: "" });
  assert.equal(resumeGuard(row, "y"), null);
  row.cases.x = { outcome: "success" }; assert.equal(resumeGuard(row, "x"), null);
});

test("the summary counts each arm per model without mixing currencies", () => {
  const ledger = newLedger(plan), row = ledger.models["vendor/model-one"];
  row.cases[caseOf("patterns").caseId] = { ...caseOf("patterns"), outcome: "success", keptItems: 3, omittedItems: 1, latencyMs: 900 };
  row.cases[caseOf("patterns", "bekommen").caseId] = { ...caseOf("patterns", "bekommen"), outcome: "failure", code: "wrong_language", latencyMs: 400 };
  const report = summarize(plan, ledger).models["vendor/model-one"].arms.patterns;
  assert.deepEqual(report, { cases: 2, success: 1, failure: 1, codes: { wrong_language: 1 }, keptItems: 3, omittedItems: 1, latencyMs: 1300 });
  assert.equal(summarize(plan, ledger).currency, "USD");
});

test("the key is read only from the given file and never alongside an inherited variable", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dict-r2-key-test-"));
  try {
    const file = resolve(dir, "synthetic-keys.env");
    writeFileSync(file, "GATEWAY_API_KEY= synthetic-value \nOTHER_API_KEY=unused\n");
    assert.equal(readKey(file, "GATEWAY_API_KEY", {}), "synthetic-value");
    assert.throws(() => readKey(file, "GATEWAY_API_KEY", { GATEWAY_API_KEY: "inherited" }), code("inherited_key_conflict"));
    assert.throws(() => readKey(file, "MISSING_API_KEY", {}), code("missing_MISSING_API_KEY"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the rehearsal configuration is synthetic and itself a valid plan", () => {
  const value = validateConfig(REHEARSAL_CONFIG);
  assert.equal(new URL(value.endpoint).hostname.endsWith(".invalid"), true);
  assert.deepEqual(value.words, ["charge"]);
  assert.equal(plannedCases(makePlan(REHEARSAL_CONFIG, fingerprints)).length, 4);
});
