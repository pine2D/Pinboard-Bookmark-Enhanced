// Guard tests for the redesign comparison driver. Pure functions only: no
// browser, no network, no credential file. Price rows are handwritten in the
// `ai-dev prices` output schema, independent of the driver's own constructors.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { makePlan, verifyPlan, authorizeScope, AUTHORIZATION, WORDS, plannedCases, plannedCounts, newLedger, reserve, settle,
  recoverLedger, auditLedger, authorizeRequest, failureLayer, parsePrice, checkBaseUrl, selectLWords, evidenceKey, summarize,
  costMicros, CRITERIA, hash, runWorkers, withRunLock, responseModelMatches, rawRecord, readGatewayKey, resumeGuard, checkDefinitions,
  freeze, report, codeFingerprints, productFiles, blindReview, armOrderFlip, publicBaseUrl, STOP_FRACTION, stopOf, responseModelAccepted,
  probeModelNames, requestSignature, negotiationStep, negotiationSummary, NEGOTIABLE_FIELDS, ROUND, LIMITS, baselineFiles, verifyPriorLedgers,
  checkBaselineDefinitions, reuseEvidence, baselineCode, requireLiveRound, codeGuard, roundCompleteness, successfulPairs, responseNames,
  reproducedJudge, main } from "../scripts/dict-redesign-test.mjs";
import { validateCard, validateReading, extractSentence, crossSectionDuplicates, duplicatePairs, negationMismatch, cardPrompt, readingPrompt,
  productPrompt, scriptCheckDrops } from "../scripts/dict-redesign-proto.mjs";

import { prices } from "./fixtures/dict-redesign-prices.mjs";
const fingerprints = { product: "p", driver: "d", proto: { module: "m", prompts: "q" } };
const plan = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints, createdAt: "2026-10-26T08:00:00.000Z" });
const rehash = copy => { delete copy.planHash; return { ...copy, planHash: hash(copy) }; };
const gemini = "commandcode/gemini-3.8-flash", glm = "commandcode/glm-5.3-flash", mimo = "commandcode/mimo-v2.6-pro", haiku = "commandcode/claude-haiku-5-5";
// One recorded probe click (base entry on provider) with the model name the
// gateway answered with. Handwritten attempt fields, as the route stores them.
const probeCase = (p, ledger, model, responseModel, status = 200) => {
  const caseId = "probe:" + model + ":provider:entry";
  const a = reserve(p, ledger, { model, caseId, inputBytes: 600, outputTokens: 8192 });
  Object.assign(a, { httpStatus: status, responseModel });
  settle(p, ledger, a, { received: true, httpStatus: status, usage: status === 200 ? { prompt_tokens: 440, completion_tokens: 190 } : undefined });
  ledger.models[model].cases[caseId] = { caseId, phase: "probe", model, wordId: "provider", arm: "entry", outcome: status === 200 ? "success" : "failure" };
  return a;
};

test("plan carries exactly the authorized models, caps, words and the cheapest two pilot models", () => {
  assert.equal(plan.models.length, 7);
  assert.equal(plan.models.reduce((s, m) => s + m.capUSD, 0) > plan.budget.totalUSD, true, "total cap binds before per-model caps sum");
  assert.equal(plan.budget.totalUSD, 12);
  assert.equal(plan.models.find(m => m.id === gemini).capUSD, 5);
  assert(plan.models.filter(m => m.id !== gemini).every(m => m.capUSD === 1.2));
  assert.deepEqual(plan.phases.pilot.models, ["commandcode/claude-haiku-5-5", glm]);
  assert.deepEqual(plan.phases.pilot.words, ["provider", "based"]);
  assert.equal(plan.phases.full.words.length, 12);
  assert.deepEqual(new Set(plan.words.map(w => w.sourceLanguage)), new Set(AUTHORIZATION.sourceLanguages));
  assert.deepEqual(plan.words.filter(w => w.target === "en").map(w => w.id), ["bekommen", "embarazada", "suibian"]);
  assert.equal(plan.limits.outputTokens, 8192); assert.equal(plan.limits.retries, 0); assert.equal(plan.limits.fallbacks, false);
  assert.equal(plan.keyVariable, "AGENTGATEWAY_API_KEY");
  assert.equal(CRITERIA.length >= 10, true);
  verifyPlan(plan);
});
test("the whitelist gate refuses any model, cap, word, language, limit or endpoint outside the authorization", () => {
  const edits = [p => p.models.push({ ...p.models[0], id: "commandcode/other-model" }), p => p.models[0].capUSD = 1.21,
    p => p.models.find(m => m.id === gemini).capUSD = 5.01, p => p.budget.totalUSD = 12.01, p => p.limits.outputTokens = 8193,
    p => p.limits.retries = 1, p => p.limits.fallbacks = true, p => p.limits.httpPerCase = 5,
    p => p.words.push({ id: "bank", term: "bank", sourceLanguage: "en", target: "zh-Hans", set: "holdout", probes: "" }),
    p => p.words[2] = { ...p.words[2], sourceLanguage: "pt" }, p => p.words[2] = { ...p.words[2], target: "ja" },
    p => p.phases.pilot.words.push("charge"), p => p.phases.full.words.push("provider"), p => p.phases.pilot.models.push(gemini),
    p => p.baseUrl = "http://192.168.1.5:48097/v1", p => p.baseUrl = "https://user:pw@example.com/v1", p => p.keyVariable = "OPENAI_API_KEY",
    p => p.baseUrl = "https://gateway.example.com/v1", p => p.baseUrl = "http://127.0.0.1:48096/v1", p => p.baseUrl = "http://localhost:48097/v1",
    p => p.arms.X = "extra", p => p.aCategories = ["collocations"], p => p.lCandidates.push("provider")];
  for (const edit of edits) {
    const copy = structuredClone(plan); edit(copy);
    assert.throws(() => authorizeScope(copy), /unauthorized_scope|base_url/, edit.toString());
    assert.throws(() => verifyPlan(rehash(copy)), /unauthorized_scope|base_url/);
  }
  assert.throws(() => makePlan({ prices, baseUrl: "https://gateway.example.com/v1", fingerprints }), /unauthorized_scope_endpoint/);
  assert.throws(() => verifyPlan({ ...plan, createdAt: "2026-10-27T00:00:00.000Z" }), /plan_tampered/);
});
test("base URL policy: HTTPS or literal loopback HTTP only", () => {
  assert.equal(checkBaseUrl("http://127.0.0.1:48097/v1/"), "http://127.0.0.1:48097/v1");
  for (const url of ["http://10.0.0.2/v1", "http://example.com/v1", "ftp://127.0.0.1/v1", "https://a@b.c/v1", "not a url", "https://x.test/v1?key=1"]) assert.throws(() => checkBaseUrl(url));
});
test("unknown, stale or reachable-tier prices refuse the plan", () => {
  const id = glm;
  for (const edit of [r => r.snapshot.stale = true, r => delete r.snapshot.stale, r => r.result[id].input_cost_per_token = null,
    r => r.result[id].output_cost_per_token = 0, r => r.result[id].litellm_provider = "openrouter", r => r.result[id].catalog_model = "glm",
    r => r.result[id].input_cost_per_token_above_20k_tokens = 1e-6, r => delete r.result[id]]) {
    const copy = structuredClone(prices[id]); edit(copy); assert.throws(() => parsePrice(id, copy), /price_|tier/);
  }
  assert.equal(parsePrice("commandcode/claude-haiku-5-5", prices["commandcode/claude-haiku-5-5"]).tierTokens, 100000);
});
test("planned clicks: pilot 2 models x 2 dev words, full 7 x 12 with four literature words", () => {
  const evidence = { lWords: { pilot: ["provider"], full: ["notwithstanding", "charge", "davat", "magari"] } };
  const pilot = plannedCases(plan, "pilot", evidence), full = plannedCases(plan, "full", evidence);
  assert.equal(pilot.length, 2 * 2 * 8 + 2 * 2);
  assert.equal(full.length, 7 * 12 * 8 + 7 * 4 * 2);
  assert.equal(new Set([...pilot, ...full].map(c => c.caseId)).size, pilot.length + full.length);
  assert(full.every(c => plan.phases.full.words.includes(c.wordId)) && pilot.every(c => ["provider", "based"].includes(c.wordId)));
  const counts = plannedCounts(plan);
  // +1 each: the 7-model probe (one base entry on the dev word provider).
  assert.equal(counts.models[gemini].clicks, 1 + 12 * 8 + 4 * 2);
  assert.equal(counts.models[glm].clicks, 1 + 12 * 8 + 4 * 2 + 2 * 8 + 2 * 2);
});

test("budget gate: worst case of the NEXT request must fit model and total caps, including in-flight reservations", () => {
  const ledger = newLedger(plan, "e");
  const model = plan.models.find(m => m.id === gemini);
  const worst = costMicros(model, 4000 + 1024, 8192);
  const a = reserve(plan, ledger, { model: gemini, caseId: "c1", inputBytes: 4000, outputTokens: 8192 });
  assert.equal(a.reservedMicros, worst);
  settle(plan, ledger, a, { received: true, httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  assert.equal(a.costMicros, costMicros(model, 1000, 500)); assert.equal(a.costBasis, "usage");
  // Fill gemini to just below its internal $4.0 stop (80% of the $5 cap) with settled spend.
  ledger.models[gemini].attempts[0].costMicros = 4e6 - worst + 1; ledger.models[gemini].spentMicros = 4e6 - worst + 1; ledger.spentMicros = 4e6 - worst + 1;
  assert.throws(() => reserve(plan, ledger, { model: gemini, caseId: "c2", inputBytes: 4000, outputTokens: 8192 }), /cost_limit_model/);
  // A smaller request still fits; refusal is about this request's worst case.
  reserve(plan, ledger, { model: gemini, caseId: "c2", inputBytes: 100, outputTokens: 64 });
});
test("total cap counts every model's settled spend and outstanding reservations", () => {
  const ledger = newLedger(plan, "e");
  for (const m of plan.models.filter(m => m.id !== gemini)) { ledger.models[m.id].spentMicros = 1.15e6; ledger.models[m.id].attempts.push({ state: "settled", reservedMicros: 0, costMicros: 1.15e6 }); }
  ledger.spentMicros = 6 * 1.15e6;
  const big = reserve(plan, ledger, { model: gemini, caseId: "g1", inputBytes: 24576, outputTokens: 8192 });
  assert.equal(big.state, "reserved");
  ledger.models[gemini].spentMicros = 0;
  // 6.9 + outstanding + many more reservations eventually exceed $12 even though gemini alone is below $5.
  let refused = "";
  for (let i = 2; i < 200 && !refused; i++) {
    try { reserve(plan, ledger, { model: gemini, caseId: "g" + i, inputBytes: 24576, outputTokens: 8192 }); }
    catch (error) { refused = error.safeCode; }
  }
  assert.equal(refused, "cost_limit_total", "6.9 settled + gemini reservations reach the $9.6 total stop before gemini's $4.0 stop");
  const committed = ledger.spentMicros + ledger.models[gemini].attempts.filter(a => a.state === "reserved").reduce((s, a) => s + a.reservedMicros, 0);
  assert(committed <= 9.6e6);
  assert(committed > 9.6e6 - costMicros(plan.models.find(m => m.id === gemini), 24576 + 1024, 8192), "stopped by the 80% gate, not earlier");
});
test("settlement is conservative when usage is missing; crashes keep the reservation; overruns halt", () => {
  const ledger = newLedger(plan, "e");
  const a = reserve(plan, ledger, { model: glm, caseId: "x", inputBytes: 2000, outputTokens: 8192 });
  settle(plan, ledger, a, { received: true, httpStatus: 200, usage: {} });
  assert.equal(a.costMicros, a.reservedMicros);
  const b = reserve(plan, ledger, { model: glm, caseId: "y", inputBytes: 2000, outputTokens: 8192 });
  settle(plan, ledger, b, { received: true, httpStatus: 400 });
  assert.equal(b.costMicros, costMicros(plan.models.find(m => m.id === glm), 3024, 0));
  const c = reserve(plan, ledger, { model: glm, caseId: "z", inputBytes: 2000, outputTokens: 8192 });
  recoverLedger(plan, ledger);
  assert.equal(c.costMicros, c.reservedMicros); assert.equal(c.failure, "uncertain_after_crash");
  const d = reserve(plan, ledger, { model: glm, caseId: "w", inputBytes: 2000, outputTokens: 1000 });
  settle(plan, ledger, d, { received: true, httpStatus: 200, usage: { prompt_tokens: 10, completion_tokens: 600, reasoning_tokens: 500 } });
  assert.equal(d.costMicros, costMicros(plan.models.find(m => m.id === glm), 10, 1100), "separately reported reasoning is billed");
  assert.equal(ledger.halted, "", "a possibly double-counted reasoning addend never halts the run");
  const e = reserve(plan, ledger, { model: glm, caseId: "u", inputBytes: 2000, outputTokens: 1000 });
  settle(plan, ledger, e, { received: true, httpStatus: 200, usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 1400 } });
  assert.equal(ledger.halted, "gateway_usage_exceeds_reservation", "output hidden in total_tokens is bounded too");
  assert.throws(() => reserve(plan, ledger, { model: glm, caseId: "v", inputBytes: 10, outputTokens: 10 }), /ledger_halted/);
});
test("non-2xx without usage: only explicit pre-generation rejections bill the input bound; 5xx/408/499/unknown bill the reservation", () => {
  const ledger = newLedger(plan, "e"), model = plan.models.find(m => m.id === gemini);
  for (const status of [400, 401, 403, 404, 422]) {
    const a = reserve(plan, ledger, { model: gemini, caseId: "r" + status, inputBytes: 4000, outputTokens: 8192 });
    settle(plan, ledger, a, { received: true, httpStatus: status });
    assert.equal(a.costMicros, costMicros(model, 5024, 0)); assert.equal(a.costBasis, "rejected_input_bound");
  }
  for (const status of [500, 502, 503, 504, 408, 499, 429, 302, 0]) {
    const a = reserve(plan, ledger, { model: gemini, caseId: "s" + status, inputBytes: 4000, outputTokens: 8192 });
    settle(plan, ledger, a, { received: true, httpStatus: status });
    assert.equal(a.costMicros, a.reservedMicros, String(status)); assert.equal(a.costBasis, "reservation");
  }
});
test("billing takes total_tokens when completion_tokens leaves reasoning out (handwritten Gemini-compat usage)", () => {
  const ledger = newLedger(plan, "e"), model = plan.models.find(m => m.id === gemini);
  const a = reserve(plan, ledger, { model: gemini, caseId: "t", inputBytes: 4000, outputTokens: 8192 });
  settle(plan, ledger, a, { received: true, httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 8300 } });
  assert.equal(a.costMicros, costMicros(model, 1000, 7300)); assert(a.costMicros > 50000, "about $0.056, not $0.0038");
  assert.equal(ledger.halted, "");
  const b = reserve(plan, ledger, { model: gemini, caseId: "t2", inputBytes: 4000, outputTokens: 8192 });
  settle(plan, ledger, b, { received: true, httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 9300 } });
  assert.equal(ledger.halted, "gateway_usage_exceeds_reservation", "8300 hidden output tokens exceed the 8192 cap");
  // completion 6000 that already contains 4000 reasoning, reported again top-level: bill 10000, do not halt.
  const ledger2 = newLedger(plan, "e"), c = reserve(plan, ledger2, { model: gemini, caseId: "t3", inputBytes: 4000, outputTokens: 8192 });
  settle(plan, ledger2, c, { received: true, httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 6000, reasoning_tokens: 4000, total_tokens: 7000 } });
  assert.equal(c.costMicros, costMicros(model, 1000, 10000)); assert.equal(ledger2.halted, "");
});
test("worst-case input rate is max(input, cache creation); pricing policies are carried into the plan", () => {
  const haiku = parsePrice("commandcode/claude-haiku-5-5", prices["commandcode/claude-haiku-5-5"]);
  assert.equal(haiku.input, 1e-7); assert.equal(haiku.inputBilled, 1.25e-7);
  assert.equal(parsePrice(gemini, prices[gemini]).inputBilled, 1.5e-6);
  assert.match(plan.pricingPolicies[gemini], /ZDR/);
  const model = plan.models.find(m => m.id === "commandcode/claude-haiku-5-5");
  assert.equal(costMicros(model, 1e6, 0), 125000);
});
test("request bounds, per-case HTTP cap and ledger tampering fail before dispatch", () => {
  for (const [bytes, out] of [[0, 10], [24577, 10], [1.5, 10], [10, 0], [10, 8193], [10, NaN], [10, Infinity]])
    assert.throws(() => reserve(plan, newLedger(plan, "e"), { model: glm, caseId: "a", inputBytes: bytes, outputTokens: out }), /request_bounds/);
  const ledger = newLedger(plan, "e");
  for (let i = 0; i < 4; i++) settle(plan, ledger, reserve(plan, ledger, { model: glm, caseId: "same", inputBytes: 10, outputTokens: 10 }), { received: true, httpStatus: 400 });
  assert.throws(() => reserve(plan, ledger, { model: glm, caseId: "same", inputBytes: 10, outputTokens: 10 }), /request_limit/);
  ledger.models[glm].spentMicros -= 1;
  assert.throws(() => auditLedger(plan, ledger), /ledger_invalid/);
  assert.throws(() => reserve(plan, { ...newLedger(plan, "e"), planHash: "other" }, { model: glm, caseId: "a", inputBytes: 10, outputTokens: 10 }), /ledger_invalid/);
  assert.throws(() => reserve(plan, newLedger(plan, "e"), { model: "commandcode/other", caseId: "a", inputBytes: 10, outputTokens: 10 }), /unauthorized_payload/);
});

const entry = { word: "charge", language: "en", pronunciation: "", meanings: [{ partOfSpeech: "名词", definition: "费用", examples: [] }, { partOfSpeech: "动词", definition: "收费", examples: [] }] };
const source = { title: "Novel/Chapter 1", url: "https://en.wikisource.org/w/index.php?oldid=9", excerpt: "The captain took charge of the ship.", author: "A", work: "Novel", location: "¶ 1", language: "en", genre: "novel", revision: "9", retrievedAt: 1 };
const frozen = { entries: { [glm]: { charge: { value: entry } } },
  evidence: { evidence: { [evidenceKey(WORDS[2], "literature")]: { ok: true, sources: [source] }, [evidenceKey(WORDS[2], "etymology")]: { ok: true, sources: [] } },
    sentences: { charge: { sentence: "The captain took charge of the ship.", work: "Novel", author: "A", location: "¶ 1" } } } };
const target = { name: "Simplified Chinese", lang: "zh-Hans" };
const active = (arm, category = arm) => ({ model: glm, wordId: "charge", arm, category, caseId: "x" });
const productPayload = (category, sources = []) => ({ category, term: "charge", sourceLanguage: "en", targetLanguage: target,
  profile: { nativeLanguage: "Simplified Chinese", level: "intermediate", topic: "" }, baseEntry: { word: "charge", language: "en", meanings: entry.meanings.map(({ partOfSpeech, definition }) => ({ partOfSpeech, definition })) },
  sources: sources.map((s, sourceIndex) => ({ ...s, sourceIndex })) });
test("content whitelist accepts only the word, language pair, frozen entry and frozen public excerpts", () => {
  assert(authorizeRequest(plan, "full", active("entry"), { term: "charge", sourceLanguage: "en", targetLanguage: target }, frozen));
  assert(authorizeRequest(plan, "full", active("A", "grammar"), productPayload("grammar"), frozen));
  assert(authorizeRequest(plan, "full", active("L-A", "literature"), productPayload("literature", [source]), frozen));
  const card = JSON.parse(cardPrompt({ term: "charge", sourceLanguage: "en", target, nativeLanguage: "Simplified Chinese", entry }).split("\n").at(-1));
  assert(authorizeRequest(plan, "full", active("B", "card"), card, frozen));
  const reading = JSON.parse(readingPrompt({ term: "charge", sourceLanguage: "en", target, entry, source: frozen.evidence.sentences.charge }).split("\n").at(-1));
  assert(authorizeRequest(plan, "full", active("L-B", "reading"), reading, frozen));
  const denied = [
    [active("entry"), { term: "charge", sourceLanguage: "en", targetLanguage: target, article: "user text" }],
    [active("entry"), { term: "bank", sourceLanguage: "en", targetLanguage: target }],
    [active("entry"), { term: "charge", sourceLanguage: "en", targetLanguage: { name: "Japanese", lang: "ja" } }],
    [active("A", "grammar"), { ...productPayload("grammar"), acceptedItems: [], missingItems: 1 }],
    [active("A", "grammar"), productPayload("register")],
    [active("A", "grammar"), { ...productPayload("grammar"), profile: { nativeLanguage: "Simplified Chinese", level: "intermediate", topic: "我的工作" } }],
    [active("A", "grammar"), { ...productPayload("grammar"), baseEntry: { ...productPayload("grammar").baseEntry, meanings: [] } }],
    [active("A", "grammar"), productPayload("grammar", [source])],
    [active("L-A", "literature"), productPayload("literature", [{ ...source, excerpt: "A user's own article sentence with charge." }])],
    [active("L-A", "literature"), productPayload("literature", [])],
    [active("B", "card"), { ...card, vocabulary: ["saved word"] }],
    [active("B", "card"), { ...card, nativeLanguage: "German" }],
    [active("L-B", "reading"), { ...reading, source: { ...reading.source, sentence: "Another sentence." } }],
    [{ ...active("A", "grammar"), model: gemini }, productPayload("grammar")],
    [{ ...active("entry"), wordId: "provider" }, { term: "provider", sourceLanguage: "en", targetLanguage: target }]
  ];
  for (const [who, payload] of denied) assert.throws(() => authorizeRequest(plan, "full", who, payload, frozen), /unauthorized_payload/, JSON.stringify(payload).slice(0, 80));
  assert.throws(() => authorizeRequest(plan, "pilot", active("entry"), { term: "charge", sourceLanguage: "en", targetLanguage: target }, frozen), /unauthorized_payload/);
});
test("literature words are the first four pre-registered candidates with a verifiable sentence; no substitution", () => {
  const census = Object.fromEntries(plan.lCandidates.map(id => [id, { literature: { sources: 1 } }]));
  const sentences = Object.fromEntries(plan.lCandidates.map(id => [id, { sentence: "x" }]));
  delete sentences.charge; census.davat.literature.sources = 0;
  assert.deepEqual(selectLWords(plan, sentences, census).full, ["notwithstanding", "magari", "actuellement", "bekommen"]);
});
test("failure layers are assigned from codes, not from model names", () => {
  assert.equal(failureLayer({ code: "output_truncated" }), "truncation");
  assert.equal(failureLayer({ code: "invalid_response", reason: "response_json", finishReason: "length" }), "truncation");
  assert.equal(failureLayer({ code: "empty_response" }), "empty");
  assert.equal(failureLayer({ code: "request_failed", reason: "http_500" }), "transport");
  assert.equal(failureLayer({ code: "request_timeout" }), "transport");
  assert.equal(failureLayer({ code: "invalid_response", reason: "supplement_fields" }), "structure");
  assert.equal(failureLayer({ code: "invalid_response", reason: "card_fields" }), "structure");
  assert.equal(failureLayer({ code: "wrong_language", reason: "explanation_script" }), "language");
  assert.equal(failureLayer({ code: "no_sources" }), "evidence");
  assert.equal(failureLayer({ code: "invalid_response", reason: "supplement_quote" }), "evidence");
  assert.equal(failureLayer({ code: "save_failed" }), "save");
  assert.equal(failureLayer({ code: "unsupported_usage" }), "content");
  for (const code of ["stale", "owner_changed", "account_changed", "ai_not_configured", "ai_disabled", "control_missing", "interrupted"]) assert.equal(failureLayer({ code }), "harness", code);
  for (const code of ["not_saved", "sync_failed", "render_failed"]) assert.equal(failureLayer({ code }), "save", code);
  assert.equal(failureLayer({ code: "invalid_response", reason: "supplement_example" }), "structure", "same layer as B's item_text");
});

const zh = "这个句型后面接具体对象，用来说明动作涉及的范围，语气比较中性。";
const detectZh = async () => ({ isReliable: true, languages: [{ language: "zh", percentage: 99 }] });
const input = { term: "charge", sourceLanguage: "en", target, nativeLanguage: "Simplified Chinese", entry };
const item = (head, note = zh, sense = 1) => ({ sense, head, note, example: "They charge a fee.", translation: "他们收取费用。" });
test("card: over-limit items are cut (not failures, not omitted); bad members are dropped one by one", async () => {
  const text = JSON.stringify({ language: "zh-Hans", patterns: Array.from({ length: 6 }, (_, i) => item("charge <x" + i + ">")), contrasts: [item("fee"), { ...item("cost"), extra: 1 }] });
  const r = await validateCard(text, input, detectZh);
  assert.equal(r.outcome, "success"); assert.equal(r.trimmed.patterns, 2); assert.equal(r.kept.patterns, 4);
  assert.equal(r.kept.contrasts, 1); assert.deepEqual(r.dropped, [{ section: "contrasts", index: 1, reason: "item_shape" }]);
  assert(!("omittedItems" in r));
});
test("card: per-item script check drops one wrong-language note; merged statistical check can fail the card", async () => {
  // Production thresholds stay permissive for short mixed prose; a whole
  // untranslated note (>=80 letters, almost no target script) is rejected.
  const english = "This note is written entirely in English and therefore it is clearly not in the requested explanation language.";
  const r = await validateCard(JSON.stringify({ language: "zh-Hans", patterns: [item("charge <x>"), item("charge <y>", english)], contrasts: [] }), input, detectZh);
  assert.equal(r.kept.patterns, 1); assert.equal(r.dropped[0].reason, "wrong_language");
  const long = Array.from({ length: 4 }, (_, i) => item("charge <z" + i + ">", zh + zh));
  const detected = await validateCard(JSON.stringify({ language: "zh-Hans", patterns: long, contrasts: [] }), input,
    async () => ({ isReliable: true, languages: [{ language: "ja", percentage: 98 }] }));
  assert.equal(detected.outcome, "failure"); assert.equal(detected.layer, "language");
});
test("card: curly-quoted source forms are stripped like production mentions; ASCII double-quoted would not be valid JSON prose anyway", async () => {
  const note = "用 “charge sb for sth” 表示向某人收费，后面接具体项目。";
  const r = await validateCard(JSON.stringify({ language: "zh-Hans", patterns: [item("charge <sb> for <sth>", note)], contrasts: [] }), input, detectZh);
  assert.equal(r.outcome, "success");
});
test("card: empty sections are a neutral result; malformed JSON, extra keys or wrong language metadata fail", async () => {
  assert.equal((await validateCard(JSON.stringify({ language: "zh-Hans", patterns: [], contrasts: [] }), input, detectZh)).outcome, "neutral");
  // Same as production: only an explicit [] is empty; missing/null is structure.
  for (const body of [{ language: "zh-Hans", patterns: [] }, { language: "zh-Hans" }, { language: "zh-Hans", patterns: null, contrasts: [] }]) {
    const r = await validateCard(JSON.stringify(body), input, detectZh);
    assert.equal(r.outcome, "failure", JSON.stringify(body)); assert.equal(r.layer, "structure"); assert.equal(r.reason, "card_fields");
  }
  assert.equal((await validateCard('{"language":"zh-Hans","patterns":[', input, detectZh)).layer, "structure");
  assert.equal((await validateCard(JSON.stringify({ language: "zh-Hans", patterns: [], contrasts: [], summary: "" }), input, detectZh)).reason, "card_fields");
  assert.equal((await validateCard(JSON.stringify({ language: "ja", patterns: [item("x")], contrasts: [] }), input, detectZh)).layer, "language");
  const allBad = await validateCard(JSON.stringify({ language: "zh-Hans", patterns: [item("x", zh, 9)], contrasts: [] }), input, detectZh);
  assert.equal(allBad.outcome, "failure"); assert.equal(allBad.layer, "structure");
});
test("reading: unreadable is neutral; translation must cover the one sentence; negation mismatches are flagged for review", async () => {
  const ri = { ...input, source: { sentence: "The captain did not take charge of the ship.", work: "N", author: "A", location: "1" } };
  assert.equal((await validateReading(JSON.stringify({ language: "zh-Hans", readable: false, sense: 0, gloss: "", translation: "" }), ri, detectZh)).outcome, "neutral");
  const ok = await validateReading(JSON.stringify({ language: "zh-Hans", readable: true, sense: 1, gloss: "这里表示负责、掌管某事。", translation: "船长没有接管这艘船。" }), ri, detectZh);
  assert.equal(ok.outcome, "success"); assert.equal(ok.negationMismatch, false);
  const flipped = await validateReading(JSON.stringify({ language: "zh-Hans", readable: true, sense: 1, gloss: "这里表示负责、掌管某事。", translation: "船长接管了这艘船。" }), ri, detectZh);
  assert.equal(flipped.negationMismatch, true, "screening flag, not an automatic verdict"); assert.equal(flipped.outcome, "success");
  const tiny = await validateReading(JSON.stringify({ language: "zh-Hans", readable: true, sense: 1, gloss: "这里表示负责、掌管某事。", translation: "船。" }), ri, detectZh);
  assert.equal(tiny.reason, "sentence_coverage");
  assert.equal((await validateReading(JSON.stringify({ language: "zh-Hans", readable: "yes", sense: 1, gloss: "x", translation: "y" }), ri, detectZh)).layer, "structure");
});
test("sentence extraction keeps one verbatim sentence with production word boundaries", () => {
  assert.equal(extractSentence("It was late. Notwithstanding the rain, she went out. Then she slept.", "notwithstanding", "en"), "Notwithstanding the rain, she went out.");
  assert.equal(extractSentence("The providers met. Nothing else.", "provider", "en"), null);
  assert.equal(extractSentence("天很冷。你随便坐吧。我们走了。", "随便", "zh"), "你随便坐吧。");
  assert.equal(extractSentence("First paragraph.\n\nОн не хотел давать ему денег. Потом ушёл.", "давать", "ru"), "Он не хотел давать ему денег.");
});
test("duplicate proxy and negation screen are generic", () => {
  const d = crossSectionDuplicates({ patterns: [{ head: "charge a fee", example: "x" }], contrasts: [{ head: "Charge a fee!", example: "y" }, { head: "cost", example: "z" }] }, "charge");
  assert.equal(d.duplicates, 2); assert.equal(d.items, 3);
  assert.equal(negationMismatch("Er kommt nicht.", "de", "He is coming.", "en"), true);
  assert.equal(negationMismatch("彼は来ない。", "ja", "他不来。", "zh-Hans"), false);
});
test("summary marks human-review criteria pending and needs 6 of 7 models for a general direction", () => {
  const ledger = newLedger(plan, "e");
  const s = summarize(plan, ledger, { census: {} });
  assert.equal(s.verdicts.C7.verdict, "pending_human_review"); assert.equal(s.verdicts.C11.verdict, "pending_human_review");
  assert.equal(s.verdicts.C1.verdict, "not_general", "no paired words supports nothing");
});

test("one worker's harness error stops every other worker; the lock is released only after all of them ended", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-lock-")), lock = join(dir, "run.lock");
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const ctx = { stop: false }, sendsAfterStop = [], lockSeenAtEnd = [];
  let started = 0;
  const worker = async name => {
    started++;
    if (name === "bad") { await sleep(15); throw Object.assign(new Error("harness"), { safeCode: "archive_isolation_failed" }); }
    for (let i = 0; i < 100; i++) {
      if (ctx.stop) break;
      await sleep(5);
      if (ctx.stop) sendsAfterStop.push(name); // a send that would have started after stop
    }
    await sleep(40); // in-flight request settling after the stop
    lockSeenAtEnd.push(fs.existsSync(lock));
  };
  await assert.rejects(withRunLock(lock, () => runWorkers(["ok1", "bad", "ok2", "queued"], 3, worker, ctx)), /harness/);
  assert.equal(ctx.stop, true); assert.equal(started, 3, "the queued model never starts");
  assert.deepEqual(lockSeenAtEnd, [true, true], "the lock outlives every worker");
  assert.equal(fs.existsSync(lock), false, "and is released afterwards");
  assert(sendsAfterStop.length <= 2, "at most the one step already in progress per worker");
  fs.writeFileSync(lock, "1");
  await assert.rejects(withRunLock(lock, async () => {}), /ledger_locked/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("resume never re-sends a click that has an attempt but no record", () => {
  const ledger = newLedger(plan, "e"), row = ledger.models[glm];
  const testCase = { caseId: "full:" + glm + ":charge:A:grammar", model: glm };
  assert.equal(resumeGuard(row, testCase), null);
  settle(plan, ledger, reserve(plan, ledger, { model: glm, caseId: testCase.caseId, inputBytes: 10, outputTokens: 10 }), { received: true, httpStatus: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.deepEqual(resumeGuard(row, testCase), { outcome: "failure", layer: "harness", code: "interrupted", reason: "no_record_after_crash", keptItems: 0 });
  row.cases[testCase.caseId] = { outcome: "success" };
  assert.equal(resumeGuard(row, testCase), null);
});
test("response model must be the requested one (no silent fallback)", () => {
  for (const actual of ["", "commandcode/gemini-3.8-flash", "gemini-3.8-flash", "Gemini-3.8-Flash", "gemini-3-8-flash-20261001"]) assert(responseModelMatches(actual, gemini), actual);
  for (const actual of ["gemini-3.8-flash-lite", "gemini-2.5-flash", "glm-5.3-flash", "commandcode/claude-haiku-5-5"]) assert(!responseModelMatches(actual, gemini), actual);
});
test("credential: only AGENTGATEWAY_API_KEY is read from a dotenv file; an inherited variable refuses; raw files never carry it", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-key-")), key = "synthetic-key-0123456789abcdef";
  fs.writeFileSync(join(dir, ".env"), "OTHER_SECRET=nope\nAGENTGATEWAY_API_KEY=" + key + "\n");
  assert.equal(readGatewayKey(dir, {}), key);
  assert.throws(() => readGatewayKey(dir, { AGENTGATEWAY_API_KEY: "x" }), /inherited_key_conflict/);
  fs.writeFileSync(join(dir, ".env"), "OTHER_SECRET=nope\n");
  assert.throws(() => readGatewayKey(dir, {}), /missing_AGENTGATEWAY_API_KEY/);
  const body = { model: glm, messages: [{ role: "user", content: "echo " + key }] };
  const raw = JSON.stringify(rawRecord({ model: glm, caseId: "c", status: 200, body, text: '{"echo":"' + key + '","h":"Bearer ' + key + '"}', key }));
  assert(!raw.includes(key)); assert(raw.includes("[REDACTED]"));
  const ledger = newLedger(plan, "e");
  settle(plan, ledger, reserve(plan, ledger, { model: glm, caseId: "c", inputBytes: 10, outputTokens: 10 }), { received: true, httpStatus: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert(!JSON.stringify(ledger).includes(key));
  fs.rmSync(dir, { recursive: true, force: true });
});
test("public providers.env must name exactly the authorized endpoint", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-env-"));
  fs.writeFileSync(join(dir, "providers.env"), "AGENTGATEWAY_BASE_URL=http://127.0.0.1:48097/v1/\n");
  assert.equal(publicBaseUrl(dir), AUTHORIZATION.endpoint);
  fs.writeFileSync(join(dir, "providers.env"), "AGENTGATEWAY_BASE_URL=https://other.example/v1\n");
  assert.throws(() => publicBaseUrl(dir), /endpoint_not_authorized/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("every outgoing product message is compared with the prompt production builds from the authorized payload", () => {
  const p = productPayload("grammar"), prompt = productPrompt("A", p);
  assert(prompt.startsWith("Create a concise language-learning supplement."));
  assert.deepEqual(JSON.parse(prompt.split("\n").at(-1)), p);
  const lit = productPayload("literature", [source]);
  assert.deepEqual(JSON.parse(productPrompt("L-A", lit).split("\n").at(-1)), lit);
  const entryPrompt = productPrompt("entry", { term: "charge", sourceLanguage: "en", targetLanguage: target });
  assert(entryPrompt.startsWith("Create a concise reusable dictionary entry"));
  assert.notEqual(productPrompt("A", productPayload("register")), prompt, "category changes the instructions");
});
test("definitions and code are frozen: freeze needs the plan's driver; report needs the frozen code", () => {
  const live = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: codeFingerprints(), createdAt: "2026-10-26T08:00:00.000Z" });
  checkDefinitions(live);
  for (const edit of [p => p.thresholds = { ...p.thresholds, tokenRatio: 0.6 }, p => p.criteria = p.criteria.slice(1), p => p.neutral = [...p.neutral, "x"],
    p => p.limits = { ...p.limits, httpPerCase: 3 }, p => p.generality = { ...p.generality, minModels: 5 }]) {
    const copy = structuredClone(live); edit(copy); assert.throws(() => checkDefinitions(copy), /definitions_changed/);
  }
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-freeze-"));
  const ledger = newLedger(live, "e"); ledger.models[glm].cases["pilot:x"] = { phase: "pilot" };
  const reset = () => { fs.rmSync(join(dir, "frozen.json"), { force: true }); fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger)); };
  reset();
  assert.throws(() => freeze(live, dir), /probe_required/, "freeze needs a probe record for every authorized model");
  for (const m of live.models) probeCase(live, ledger, m.id, m.id === mimo ? "xiaomi/mimo-v2.6-pro-preview" : m.id);
  reset();
  assert.throws(() => freeze({ ...live, fingerprints: { ...live.fingerprints, driver: "old" } }, dir), /driver_code_changed/);
  assert.throws(() => freeze({ ...live, fingerprints: { ...live.fingerprints, product: "old" } }, dir), /product_code_changed/);
  const protoPlan = { ...live, fingerprints: { ...live.fingerprints, proto: { module: "old", prompts: "old" } } };
  assert.throws(() => freeze(protoPlan, dir), /proto_change_note_required/);
  const frozen = freeze(protoPlan, dir, "tightened the contrasts wording");
  assert.equal(frozen.protoChangedSincePlan, true); assert.equal(frozen.protoChangeNote, "tightened the contrasts wording");
  reset();
  const registered = freeze(live, dir);
  assert.deepEqual(registered.modelNames[mimo], ["xiaomi/mimo-v2.6-pro-preview"], "the probe-observed alias is registered in frozen.json");
  assert.deepEqual(registered.probes[mimo].aliases, ["xiaomi/mimo-v2.6-pro-preview"]);
  assert.deepEqual(registered.modelNames[gemini], [gemini]);
  fs.writeFileSync(join(dir, "evidence.json"), JSON.stringify({ planHash: live.planHash, evidence: {}, sentences: {}, lWords: {}, census: {}, evidenceHash: hash({ evidence: {}, sentences: {}, lWords: {} }) }));
  const stored = JSON.parse(fs.readFileSync(join(dir, "ledger.json"), "utf8")); stored.evidenceHash = hash({ evidence: {}, sentences: {}, lWords: {} });
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(stored));
  report(live, dir);
  assert(fs.existsSync(join(dir, "review-usage.json")) && fs.existsSync(join(dir, "review-key-usage.json")));
  const frozenFile = JSON.parse(fs.readFileSync(join(dir, "frozen.json"), "utf8"));
  frozenFile.fingerprints.driver = "edited after the run"; fs.writeFileSync(join(dir, "frozen.json"), JSON.stringify(frozenFile));
  assert.throws(() => report(live, dir), /frozen_mismatch|code_changed_since_freeze/);
  const tweaked = structuredClone(live); tweaked.thresholds.tokenRatio = 0.9;
  assert.throws(() => report(tweaked, dir), /frozen_mismatch|definitions_changed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("full refuses a frozen.json whose model-name registry is missing or edited", () => {
  const live = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: codeFingerprints(), createdAt: "2026-10-26T08:00:00.000Z" });
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-names-"));
  const ledger = newLedger(live, "e"); ledger.models[glm].cases["pilot:x"] = { phase: "pilot" };
  for (const m of live.models) probeCase(live, ledger, m.id, m.id);
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger)); freeze(live, dir);
  fs.writeFileSync(join(dir, "evidence.json"), JSON.stringify({ planHash: live.planHash, evidence: {}, sentences: {}, lWords: {}, census: {}, evidenceHash: hash({ evidence: {}, sentences: {}, lWords: {} }) }));
  const stored = JSON.parse(fs.readFileSync(join(dir, "ledger.json"), "utf8")); stored.evidenceHash = hash({ evidence: {}, sentences: {}, lWords: {} });
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(stored));
  report(live, dir);
  const frozenFile = JSON.parse(fs.readFileSync(join(dir, "frozen.json"), "utf8"));
  frozenFile.modelNames[gemini].push("commandcode/gemini-3.8-flash-lite"); fs.writeFileSync(join(dir, "frozen.json"), JSON.stringify(frozenFile));
  assert.throws(() => report(live, dir), /frozen_mismatch/, "a name added after freeze breaks the frozen hash");
  fs.rmSync(dir, { recursive: true, force: true });
});
test("product fingerprint covers every runtime file the library page can load", () => {
  const files = productFiles();
  for (const file of ["background.js", "library.js", "i18n.js", "library.html", "manifest.json", "dict-entry.js", "_locales/en/messages.json"]) assert(files.includes(file), file);
  assert(!files.some(file => file.startsWith("scripts/") || file.startsWith("tests/")));
});
test("B/A order inside a word is rotated by the pre-registered seed; entry always first", () => {
  const cases = plannedCases(plan, "full");
  const flips = plan.phases.full.models.flatMap(model => plan.phases.full.words.map(word => armOrderFlip(model, word, "full")));
  assert(flips.includes(true) && flips.includes(false));
  for (const model of plan.phases.full.models) for (const word of plan.phases.full.words) {
    const own = cases.filter(c => c.model === model && c.wordId === word);
    assert.equal(own[0].arm, "entry");
    const bIndex = own.findIndex(c => c.arm === "B"), aIndex = own.findIndex(c => c.arm === "A");
    assert.equal(bIndex > aIndex, armOrderFlip(model, word, "full"));
  }
});
const record = (model, wordId, arm, category, outcome, extra = {}) => ({ caseId: ["full", model, wordId, arm, category].join(":"), phase: "full", model, wordId, arm, category,
  outcome, layer: "", code: "", usage: { prompt_tokens: 100, completion_tokens: 50, output_tokens: 50 }, latencyMs: 1000, harnessMs: 50, costMicros: 1, keptItems: 1, returnedItems: 1, trimmedItems: 0, ...extra });
test("C1-C3 use paired words; harness failures are excluded and counted; a model above the harness share supports nothing", () => {
  const ledger = newLedger(plan, "e"), row = ledger.models[glm];
  for (const wordId of plan.phases.full.words) {
    row.cases["B" + wordId] = record(glm, wordId, "B", "card", "success", { content: { patterns: [{ head: "x " + wordId, note: "n", example: "e" + wordId }], contrasts: [] } });
    for (const category of ["collocations", "confusables", "register", "grammar", "scenarios"]) row.cases[category + wordId] = record(glm, wordId, "A", category, "success", { content: [{ title: category, explanation: "n", example: category + wordId }] });
  }
  // An unpaired word (one A5 category never observed) leaves the main rates: its B failure counts only in allClicks.
  delete row.cases["scenariosran"]; row.cases["Bran"] = record(glm, "ran", "B", "card", "failure", { layer: "structure" });
  let s = summarize(plan, ledger, { census: {} }).models[glm];
  assert.equal(s.pairedWords, 11); assert.equal(s.B.failureRate, 0); assert.equal(s.variants.allClicks.B.failure, 1);
  // Harness failures: excluded from rates and counted; below 10% the model still supports.
  for (const wordId of ["charge", "magari", "bekommen"]) row.cases["Ah" + wordId] = record(glm, wordId, "A", "grammar", "failure", { layer: "harness", code: "interrupted" });
  s = summarize(plan, ledger, { census: {} });
  assert.equal(s.models[glm].A5.harness, 3); assert.equal(s.models[glm].A5.failure, 0);
  assert.equal(s.verdicts.C1.models.find(m => m.model === glm).supports, true, "3 of 58 is below the 10% share");
  for (const wordId of plan.phases.full.words) row.cases["Ah2" + wordId] = record(glm, wordId, "A", "register", "failure", { layer: "harness", code: "interrupted" });
  s = summarize(plan, ledger, { census: {} });
  assert(s.models[glm].harnessShare > 0.1);
  assert.equal(s.verdicts.C1.models.find(m => m.model === glm).supports, false);
});
test("blind sheets hide arm and model; usage rows from B and A share one shape; flagged duplicate pairs from both arms", () => {
  const ledger = newLedger(plan, "e"), row = ledger.models[glm];
  ledger.entries[glm] = { charge: { value: entry } };
  row.cases.b = record(glm, "charge", "B", "card", "success", { content: { patterns: [{ sense: 1, head: "charge a fee", note: "n1", example: "They charge a fee.", translation: "t" }],
    contrasts: [{ sense: 2, head: "cost", note: "n2", example: "They charge a fee.", translation: "t" }] } });
  row.cases.a = record(glm, "charge", "A", "grammar", "success", { content: [{ sense: 1, title: "charge sb for sth", explanation: "e", example: "x", translation: "y" }] });
  row.cases.la = record(glm, "charge", "L-A", "literature", "success", { content: [{ sense: 1, title: "Novel", explanation: "g", example: "The captain took charge of the ship. Nobody spoke.", translation: "船长接管了船。", sourceIndex: 0 }] });
  row.cases.lb = record(glm, "charge", "L-B", "reading", "success", { sentence: "The captain took charge of the ship.", content: { sense: 1, gloss: "g", translation: "船长接管了船。" }, negationMismatch: false, coverage: 1 });
  const review = blindReview(plan, ledger, { sentences: { charge: { sentence: "The captain took charge of the ship." } } });
  const text = JSON.stringify([review.literature.sheet, review.usage.sheet, review.duplicates.sheet]);
  assert(!text.includes(glm) && !/"arm"|"L-A"|"L-B"|"model"/.test(text));
  assert.equal(review.usage.sheet.length, 3);
  for (const r of review.usage.sheet) assert.deepEqual(Object.keys(r).sort(), ["example", "head", "id", "kind", "noIncrement", "note", "senseDefinition", "sourceLanguage", "target", "term", "translation", "wrong"]);
  assert.deepEqual(new Set(review.usage.key.map(k => k.arm)), new Set(["A", "B"]));
  assert(review.literature.sheet.every(r => r.focus === "The captain took charge of the ship."), "both arms judged on the same focus sentence");
  assert.equal(review.duplicates.sheet.length, 1); assert.equal(review.duplicates.key[0].arm, "B");
  assert.equal(typeof review.literature.key.find(k => k.arm === "L-A").negation, "boolean", "negation screened for L-A too");
});
test("duplicate pairs and the symmetric script check are generic", async () => {
  assert.deepEqual(duplicatePairs({ a: [{ head: "x y" }], b: [{ head: "X y!" }, { head: "z" }] }, "t"), [[{ section: "a", index: 0 }, { section: "b", index: 0 }]]);
  const english = "This note is written entirely in English and therefore it is clearly not in the requested explanation language.";
  assert.equal(await scriptCheckDrops([zh, english], target, "zh-Hans"), 1);
});

// ---- User rulings of 2026-10-26 ----
test("stop gates are 80% of the authorized caps; the caps stay recorded as authorized", () => {
  assert.equal(STOP_FRACTION, 0.8);
  assert.equal(plan.budget.totalUSD, 12); assert.equal(plan.budget.stopUSD, 9.6); assert.equal(plan.budget.stopFraction, 0.8);
  assert.equal(plan.models.find(m => m.id === gemini).capUSD, 5); assert.equal(plan.models.find(m => m.id === gemini).stopUSD, 4);
  assert(plan.models.filter(m => m.id !== gemini).every(m => m.capUSD === 1.2 && m.stopUSD === 0.96));
  assert.equal(stopOf(1.2), 0.96); assert.equal(stopOf(5), 4); assert.equal(stopOf(12), 9.6);
  // The plan states the gate and the unbudgeted surcharges.
  assert.match(plan.budget.gate, /80%/); assert.match(plan.budget.gate, /\$9\.6/); assert.match(plan.budget.gate, /\$0\.96/);
  assert.deepEqual(plan.budget.unbudgetedSurcharges.models, [gemini], "fixture: only gemini's policy names ZDR/额度");
  assert.match(plan.boundaries.prices, /ZDR/);
  // A plan that moves a stop gate, or records a cap other than the authorized one, is refused.
  for (const edit of [p => p.models[0].stopUSD = 1.2, p => p.models.find(m => m.id === gemini).stopUSD = 5, p => p.budget.stopUSD = 12,
    p => p.budget.stopFraction = 0.9, p => p.models[0].capUSD = 1.0, p => p.budget.totalUSD = 10, p => delete p.budget.stopUSD]) {
    const copy = structuredClone(plan); edit(copy);
    assert.throws(() => authorizeScope(copy), /unauthorized_scope_(?:model|total)_cap/, edit.toString());
  }
});
test("a non-gemini model stops at $0.96, not $1.2; gemini at $4.0, not $5", () => {
  for (const [id, stop] of [[glm, 0.96e6], [gemini, 4e6]]) {
    const ledger = newLedger(plan, "e"), model = plan.models.find(m => m.id === id);
    const small = costMicros(model, 10 + 1024, 10);
    ledger.models[id].attempts.push({ state: "settled", reservedMicros: 0, costMicros: stop - small });
    ledger.models[id].spentMicros = stop - small; ledger.spentMicros = stop - small;
    reserve(plan, ledger, { model: id, caseId: "fits", inputBytes: 10, outputTokens: 10 });
    assert.throws(() => reserve(plan, ledger, { model: id, caseId: "over", inputBytes: 10, outputTokens: 10 }), /cost_limit_model/, id);
  }
});
test("probe: one production base entry per authorized model on provider; counted in the plan and the budget", () => {
  assert.deepEqual([...plan.phases.probe.models].sort(), plan.models.map(m => m.id).sort());
  assert.deepEqual(plan.phases.probe.words, ["provider"]);
  const probe = plannedCases(plan, "probe");
  assert.equal(probe.length, 7);
  assert(probe.every(c => c.arm === "entry" && c.wordId === "provider" && c.phase === "probe" && c.caseId === "probe:" + c.model + ":provider:entry"));
  // Pilot dev-word cases stay as they were: haiku and glm, 2 words x 8 arms + provider L.
  assert.equal(plannedCases(plan, "pilot", { lWords: { pilot: ["provider"] } }).length, 2 * 2 * 8 + 2 * 2);
  const counts = plannedCounts(plan);
  // Before evidence, literature is counted at its upper bound (both dev words, four holdout words).
  assert.equal(counts.clicks, 7 + 2 * 2 * 8 + 2 * 2 * 2 + 7 * 12 * 8 + 7 * 4 * 2);
  // Probe content gate: only the entry payload of provider, for any authorized model.
  const payload = { term: "provider", sourceLanguage: "en", targetLanguage: { name: "Simplified Chinese", lang: "zh-Hans" } };
  const who = (model, arm = "entry", wordId = "provider") => ({ model, wordId, arm, category: arm === "entry" ? "entry" : "card", caseId: "probe:" + model });
  assert(authorizeRequest(plan, "probe", who(gemini), payload, {}));
  assert(authorizeRequest(plan, "probe", who(mimo), payload, {}));
  assert.throws(() => authorizeRequest(plan, "probe", who(gemini, "B"), payload, {}), /unauthorized_payload/);
  assert.throws(() => authorizeRequest(plan, "probe", who(gemini, "entry", "based"), { ...payload, term: "based" }, {}), /unauthorized_payload/);
  // A probe request passes the same budget gate and is billed in the same ledger.
  const ledger = newLedger(plan, "e");
  const a = probeCase(plan, ledger, gemini, gemini);
  assert.equal(a.costBasis, "usage"); assert.equal(ledger.models[gemini].spentMicros, a.costMicros);
  // Scope gate: the probe must cover every authorized model and only provider.
  for (const edit of [p => p.phases.probe.models.pop(), p => p.phases.probe.words = ["based"], p => p.phases.probe.words.push("charge"),
    p => p.phases.probe.arms = ["entry", "B"], p => delete p.phases.probe]) {
    const copy = structuredClone(plan); edit(copy);
    assert.throws(() => authorizeScope(copy), /unauthorized_scope_probe/, edit.toString());
  }
});
test("probe names: registered when observed on 2xx; a fallback to another authorized model or a malformed name is never registered", () => {
  const ledger = newLedger(plan, "e");
  probeCase(plan, ledger, mimo, "xiaomi/mimo-v2.6-pro-preview");
  probeCase(plan, ledger, glm, "z-ai/GLM-5.3-Flash");
  probeCase(plan, ledger, "commandcode/deepseek-v4.1-flash", "glm-5.3-flash");
  probeCase(plan, ledger, "commandcode/ling-3.1-flash", "ling 3.1 <flash>");
  probeCase(plan, ledger, "commandcode/minimax-m3.1-flash", "", 403);
  const names = probeModelNames(plan, ledger);
  assert.deepEqual(names[mimo].accepted, ["xiaomi/mimo-v2.6-pro-preview"]); assert.deepEqual(names[mimo].aliases, ["xiaomi/mimo-v2.6-pro-preview"]);
  assert.deepEqual(names[glm].accepted, ["z-ai/GLM-5.3-Flash"]); assert.deepEqual(names[glm].aliases, [], "matches its own request ID");
  assert.deepEqual(names["commandcode/deepseek-v4.1-flash"].accepted, []); assert.deepEqual(names["commandcode/deepseek-v4.1-flash"].rejected, ["glm-5.3-flash"]);
  assert.deepEqual(names["commandcode/ling-3.1-flash"].accepted, []);
  assert.equal(names["commandcode/minimax-m3.1-flash"].recorded, true); assert.deepEqual(names["commandcode/minimax-m3.1-flash"].observed, [], "a 403 observes no name");
  assert.equal(names[gemini].recorded, false);
  // Pilot/full: the request ID or exactly a registered name; anything else stops the model.
  assert(responseModelAccepted("xiaomi/mimo-v2.6-pro-preview", mimo, names[mimo].accepted));
  assert(responseModelAccepted("commandcode/mimo-v2.6-pro", mimo, names[mimo].accepted));
  assert(!responseModelAccepted("xiaomi/mimo-v2.6-pro-preview", mimo, []), "without the registry the alias stops the model");
  assert(!responseModelAccepted("XIAOMI/mimo-v2.6-pro-preview", mimo, names[mimo].accepted), "registered names match exactly");
  assert(!responseModelAccepted("xiaomi/mimo-v2.6-flash", mimo, names[mimo].accepted));
  assert(!responseModelAccepted("glm-5.3-flash", "commandcode/deepseek-v4.1-flash", names["commandcode/deepseek-v4.1-flash"].accepted));
  assert(!responseModelAccepted("commandcode/gemini-3.8-flash-lite", gemini, [gemini]));
});
const negotiationBody = (extra = {}) => ({ model: glm, messages: [{ role: "user", content: "prompt" }], temperature: 0.3,
  response_format: { type: "json_object" }, max_completion_tokens: 8192, reasoning_effort: "none", ...extra });
test("negotiation: a resend is admitted only right after a 400/422 to the same click, changing only negotiable fields", () => {
  assert.deepEqual(NEGOTIABLE_FIELDS, ["max_tokens", "max_completion_tokens", "temperature", "reasoning_effort", "response_format"]);
  const first = negotiationBody();
  // httpError is what the route stores from httpErrorMetadata: fixed labels only.
  const previous = (status, named = ["response_format", "reasoning_effort", "max_completion_tokens"]) =>
    ({ n: 1, state: "settled", httpStatus: status, signature: requestSignature(first), httpError: { mentionedParameters: named, formatEnumRefusal: false } });
  const { response_format, ...withoutFormat } = first;
  assert.equal(negotiationStep(undefined, first), null, "the first request of a click is not a resend");
  assert.deepEqual(negotiationStep(previous(400, ["response_format"]), withoutFormat),
    { after: 400, afterAttempt: 1, named: ["response_format"], changed: ["response_format"], removed: ["response_format"] });
  assert.deepEqual(negotiationStep(previous(400, ["json_object"]), withoutFormat).changed, ["response_format"], "a json_object enum refusal names response_format");
  assert.deepEqual(negotiationStep(previous(400, ["structured_outputs"]), withoutFormat).changed, ["response_format"], "a structured-outputs feature refusal names response_format");
  assert.deepEqual(negotiationStep(previous(422, ["reasoning_effort"]), { ...first, reasoning_effort: "low" }).changed, ["reasoning_effort"]);
  const { max_completion_tokens, ...renamed } = first;
  assert.deepEqual(negotiationStep(previous(400, ["max_completion_tokens"]), { ...renamed, max_tokens: 8192 }).changed, ["max_completion_tokens", "max_tokens"]);
  // The refusal must name a parameter the resend changes.
  assert.throws(() => negotiationStep(previous(400, []), withoutFormat), /unexpected_resend/, "a 400 that names nothing is not negotiation");
  assert.throws(() => negotiationStep(previous(400, ["temperature"]), withoutFormat), /unexpected_resend/, "dropping a field the server did not name");
  assert.throws(() => negotiationStep({ ...previous(400), httpError: undefined }, withoutFormat), /unexpected_resend/);
  // Refused: after any other status, after no answer, unchanged, other fields, other messages or model.
  for (const status of [200, 401, 403, 404, 408, 429, 500, 502, 503, 0, undefined])
    assert.throws(() => negotiationStep(previous(status), withoutFormat), /unexpected_resend/, String(status));
  assert.throws(() => negotiationStep({ n: 1, state: "reserved", signature: requestSignature(first) }, withoutFormat), /unexpected_resend/);
  assert.throws(() => negotiationStep(previous(400), first), /unexpected_resend/, "an identical resend is a retry");
  assert.throws(() => negotiationStep(previous(400), { ...first, messages: [{ role: "user", content: "prompt 2" }] }), /unexpected_resend/);
  assert.throws(() => negotiationStep(previous(400), { ...first, model: gemini, response_format: undefined }), /unexpected_resend/);
  assert.throws(() => negotiationStep(previous(400), { ...withoutFormat, stream: false }), /unexpected_resend/);
});
test("negotiation resends are counted per model in the ledger, audited, capped at 4 HTTP per click, and listed by phase in the summary", () => {
  const ledger = newLedger(plan, "e"), row = ledger.models[glm];
  const send = (caseId, body, status, previous) => {
    const negotiation = negotiationStep(previous, body);
    const a = reserve(plan, ledger, { model: glm, caseId, inputBytes: 2000, outputTokens: 8192, negotiation });
    a.signature = requestSignature(body);
    Object.assign(a, { httpStatus: status, ...(status === 200 ? {} : { httpError: { mentionedParameters: ["response_format", "reasoning_effort", "temperature", "max_completion_tokens"], formatEnumRefusal: false } }) });
    settle(plan, ledger, a, { received: true, httpStatus: status, usage: status === 200 ? { prompt_tokens: 900, completion_tokens: 300 } : undefined });
    return a;
  };
  const body = negotiationBody(), { response_format, ...noFormat } = body, { reasoning_effort, ...noEffort } = noFormat;
  const a1 = send("pilot:" + glm + ":provider:A:grammar", body, 400);
  const a2 = send("pilot:" + glm + ":provider:A:grammar", noFormat, 400, a1);
  send("pilot:" + glm + ":provider:A:grammar", noEffort, 200, a2);
  const b1 = send("full:" + glm + ":charge:B", body, 422);
  send("full:" + glm + ":charge:B", noFormat, 200, b1);
  send("full:" + glm + ":charge:A:register", noFormat, 200);
  assert.equal(row.negotiationResends, 3);
  assert.equal(a2.negotiation.after, 400); assert.equal(a1.negotiation, undefined);
  auditLedger(plan, ledger);
  const s = negotiationSummary(plan, ledger)[glm];
  assert.deepEqual(s.byPhase, { pilot: 2, full: 1 }); assert.equal(s.resends, 3); assert.equal(s.clicks, 2);
  assert.deepEqual(s.changed, { response_format: 2, reasoning_effort: 1 }); assert.deepEqual(s.afterStatus, { 400: 2, 422: 1 });
  assert(s.costMicros > 0, "resends are billed (here: the 400 resend at its input bound and the 200s at usage)");
  const refused = [a1, a2, b1].reduce((sum, a) => sum + a.costMicros, 0);
  assert.equal(s.refusedCostMicros, refused, "the refused requests that triggered a resend are reported as negotiation overhead");
  assert.equal(negotiationSummary(plan, ledger)[gemini].resends, 0);
  // The report carries the same per-model section.
  const summary = summarize(plan, ledger, { census: {} });
  assert.deepEqual(summary.negotiation[glm].byPhase, { pilot: 2, full: 1 });
  assert.equal(summary.budget.stopUSD, 9.6); assert.equal(summary.budget.models[gemini].stopUSD, 4); assert.equal(summary.budget.models[gemini].authorizedUSD, 5);
  // Tampering with the counter fails the audit.
  row.negotiationResends = 2; assert.throws(() => auditLedger(plan, ledger), /ledger_invalid/);
  row.negotiationResends = 3;
  // A fourth resend inside one click would be the fifth HTTP request: refused before dispatch.
  const c1 = send("full:" + glm + ":ran:B", body, 400);
  const c2 = send("full:" + glm + ":ran:B", noFormat, 400, c1);
  const c3 = send("full:" + glm + ":ran:B", noEffort, 400, c2);
  const { temperature, ...noTemp } = noEffort;
  const c4 = send("full:" + glm + ":ran:B", noTemp, 400, c3);
  const { max_completion_tokens, ...noTokens } = noTemp;
  assert.throws(() => reserve(plan, ledger, { model: glm, caseId: "full:" + glm + ":ran:B", inputBytes: 2000, outputTokens: 8192,
    negotiation: negotiationStep(c4, { ...noTokens, max_tokens: 8192 }) }), /request_limit/);
  assert.equal(row.attempts.filter(a => a.caseId === "full:" + glm + ":ran:B").length, 4);
});

// ---- The 180 s round (ROUND): mimo alone after the halted ling+mimo round, prior spend counted ----
const ling = "commandcode/ling-3.1-flash";
const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const plainOf = value => JSON.parse(JSON.stringify(value));
const roundPlan = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: { ...fingerprints, product: ROUND.product, proto: plainOf(ROUND.baseline.proto) },
  createdAt: "2026-10-26T14:00:00.000Z", round: ROUND });
test("round plan: mimo alone at $1.2 (stop $0.96), no pilot, 180 s, the five earlier ledgers' spend pinned", () => {
  assert.equal(roundPlan.schema, 3); assert.deepEqual(roundPlan.round, plainOf(ROUND));
  assert.deepEqual(roundPlan.models.map(m => [m.id, m.capUSD, m.stopUSD]), [[mimo, 1.2, 0.96]]);
  assert.equal(roundPlan.budget.totalUSD, 12); assert.equal(roundPlan.budget.stopUSD, 9.6);
  assert.deepEqual(roundPlan.phases.pilot.models, []); assert.deepEqual(roundPlan.phases.probe.models, [mimo]); assert.deepEqual(roundPlan.phases.full.models, [mimo]);
  for (const phase of ["probe", "pilot", "full"]) assert.deepEqual(roundPlan.phases[phase].words, plan.phases[phase].words, phase);
  assert.equal(roundPlan.limits.timeoutMs, 180000); assert.equal(LIMITS.timeoutMs, ROUND.timeoutMs);
  // Every planned case of mimo: probe + 12 holdout words x 8 arms + 4 literature words x 2.
  const counts = plannedCounts(roundPlan);
  assert.deepEqual(counts.models[mimo], { clicks: 1 + 12 * 8 + 4 * 2, httpCap: Math.ceil(105 * 1.25) + 4 }); assert.equal(counts.clicks, 105);
  assert.equal(plannedCases(roundPlan, "pilot").length, 0);
  assert.equal(ROUND.prior.ledgers.reduce((sum, row) => sum + row.spentMicros, 0), ROUND.prior.totalMicros);
  assert.equal(Object.values(ROUND.prior.models).reduce((sum, value) => sum + value, 0), ROUND.prior.totalMicros);
  assert.match(roundPlan.budget.gate, /\$1\.711774/); assert.match(roundPlan.budget.gate, /mimo-v2\.6-pro \$0\.96 of \$1\.2/);
  // The halted ling+mimo round is one of the pinned earlier ledgers.
  assert(ROUND.prior.ledgers.some(row => row.dir.endsWith("dict-redesign-2026-10-26-timeout-180s") && row.spentMicros === 105370));
  assert(Object.isFrozen(ROUND.prior.models) && Object.isFrozen(ROUND.baseline.files), "the pins are deeply frozen");
  verifyPlan(roundPlan);
  for (const edit of [p => p.models.push(structuredClone(plan.models.find(m => m.id === glm))), p => p.models.push(structuredClone(plan.models.find(m => m.id === ling))),
    p => { p.models[0].capUSD = 2; p.models[0].stopUSD = 1.6; }, p => p.phases.pilot.models = [mimo], p => p.round.prior.totalMicros = 0,
    p => p.round.prior.models[ling] = 0, p => p.round.id = "other", p => p.round.caps[mimo] = 5, p => p.limits = { ...p.limits, timeoutMs: 60000 },
    p => p.fingerprints.proto = { module: "tuned", prompts: "tuned" }, p => p.words = p.words.slice(1), p => p.lCandidates = [...p.lCandidates].reverse(),
    p => p.phases.full.models = [ling], p => { p.schema = 2; delete p.round; }, p => p.schema = 2, p => p.fingerprints.product = "p",
    p => p.round.product = "p"]) {
    const copy = structuredClone(roundPlan); edit(copy);
    assert.throws(() => authorizeScope(copy), /unauthorized_scope_/, edit.toString());
  }
});
test("a base plan carries no round: a stray one (say, a negative prior) is refused before reserve, freeze or report can read it", () => {
  const stray = rehash({ ...structuredClone(plan), round: { ...plainOf(ROUND), prior: { ...plainOf(ROUND.prior), models: { [mimo]: -1e9 }, totalMicros: -1e9 } } });
  assert.throws(() => verifyPlan(stray), /unauthorized_scope_identity/);
  assert.throws(() => authorizeScope({ ...plan, round: null }), /unauthorized_scope_identity/);
  assert(verifyPlan(plan));
});
test("live phases run only the pinned round: a base plan or an injected round is refused", () => {
  assert.throws(() => requireLiveRound(plan, ROUND), /round_plan_required/);
  const fake = structuredClone(plainOf(ROUND)); fake.caps[mimo] = 5;
  assert.throws(() => requireLiveRound(roundPlan, fake), /round_plan_required/);
  assert.throws(() => verifyPlan(roundPlan, fake), /unauthorized_scope_identity/);
  assert(requireLiveRound(roundPlan, ROUND));
});
test("round budget gate adds the earlier ledgers' spend, per model and in total", () => {
  const model = roundPlan.models.find(m => m.id === mimo), small = costMicros(model, 10 + 1024, 10);
  const room = 0.96e6 - ROUND.prior.models[mimo], ledger = newLedger(roundPlan, "e");
  ledger.models[mimo].attempts.push({ state: "settled", reservedMicros: 0, costMicros: room - small });
  ledger.models[mimo].spentMicros = room - small; ledger.spentMicros = room - small;
  reserve(roundPlan, ledger, { model: mimo, caseId: "fits", inputBytes: 10, outputTokens: 10 });
  assert.throws(() => reserve(roundPlan, ledger, { model: mimo, caseId: "over", inputBytes: 10, outputTokens: 10 }), /cost_limit_model/);
  // The same ledger without the prior spend would still have room: the prior is what stops it.
  const fresh = structuredClone(roundPlan); delete fresh.round;
  reserve(fresh, structuredClone(ledger), { model: mimo, caseId: "over", inputBytes: 10, outputTokens: 10 });
  // The prior total counts toward the $9.6 stop even when the model's own room is ample.
  const tight = structuredClone(roundPlan); tight.round.prior.totalMicros = 9.6e6 - small + 1;
  assert.throws(() => reserve(tight, newLedger(tight, "e"), { model: mimo, caseId: "t", inputBytes: 10, outputTokens: 10 }), /cost_limit_total/);
  // A worst-case request at the full input bound and 8192 output tokens still fits mimo's remaining room.
  const worst = costMicros(model, LIMITS.inputBytes + LIMITS.framingTokens, LIMITS.outputTokens);
  assert(ROUND.prior.models[mimo] + worst < 0.96e6);
});
// A synthetic archived baseline, pinned file by file as ROUND pins the real
// one, in a root of its own (where the inventory of earlier ledgers looks).
// ling and mimo answered under their upstream names there.
const fileSha = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
function syntheticBaseline(planFingerprints = { ...fingerprints, proto: plainOf(ROUND.baseline.proto) }) {
  const root = fs.mkdtempSync(join(tmpdir(), "dict-redesign-baseline-")), dir = join(root, "dict-redesign-main");
  fs.mkdirSync(dir);
  const basePlan = rehash({ ...structuredClone(plan), limits: { ...plan.limits, timeoutMs: 60000 } });
  const evidence = { schema: 1, planHash: basePlan.planHash, evidence: { "en:charge:literature": { ok: true, code: "", sources: [] } }, sentences: {}, census: {} };
  evidence.lWords = selectLWords(basePlan, evidence.sentences, evidence.census);
  evidence.evidenceHash = hash({ evidence: evidence.evidence, sentences: evidence.sentences, lWords: evidence.lWords });
  const frozen = { planHash: basePlan.planHash, fingerprints: { product: "p", driver: "d", proto: plainOf(ROUND.baseline.proto) }, modelNames: {} };
  const ledger = { ...newLedger(basePlan, evidence.evidenceHash), frozenHash: hash(frozen) };
  ledger.models[ling].attempts.push({ caseId: "full:" + ling + ":charge:B", state: "settled", reservedMicros: 900, costMicros: 700, httpStatus: 200, responseModel: "inclusionai/ling-3.1-flash" });
  ledger.models[mimo].attempts.push({ caseId: "full:" + mimo + ":charge:B", state: "settled", reservedMicros: 900, costMicros: 0, httpStatus: 200, responseModel: "xiaomi/mimo-v2.6-pro" });
  ledger.models[ling].spentMicros = 700; ledger.spentMicros = 700;
  const files = { "plan.json": basePlan, "ledger.json": ledger, "evidence.json": evidence, "frozen.json": frozen, "report.json": { verdicts: {} } };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(join(dir, name), JSON.stringify(body));
  const pins = Object.fromEntries(Object.keys(files).map(name => [name, fileSha(join(dir, name))]));
  const round = { ...plainOf(ROUND), product: planFingerprints.product,
    baseline: { ...plainOf(ROUND.baseline), dir, planHash: basePlan.planHash, evidenceHash: evidence.evidenceHash, frozenHash: ledger.frozenHash, files: pins },
    prior: { root, ledgers: [{ dir, sha256: pins["ledger.json"], spentMicros: 700 }], models: Object.fromEntries(plan.models.map(m => [m.id, m.id === ling ? 700 : 0])), totalMicros: 700 } };
  const roundPlanT = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: planFingerprints, round });
  return { root, dir, basePlan, evidence, ledger, round, roundPlanT };
}
test("round freeze: the probe only, no pilot cases; the prototype may not move, even with a note; no name the baseline never saw", () => {
  const { root, roundPlanT: live } = syntheticBaseline(codeFingerprints());
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-round-freeze-"));
  const ledger = newLedger(live, "e");
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger));
  assert.throws(() => freeze(live, dir), /probe_required/);
  // An alias the baseline never saw for the model (a different model behind
  // it?) is never registered, so full could not accept it either.
  const renamed = structuredClone(ledger);
  probeCase(live, renamed, mimo, "xiaomi/mimo-v2.6-pro-preview");
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(renamed));
  assert.throws(() => freeze(live, dir), /model_identity_changed/);
  probeCase(live, ledger, mimo, "xiaomi/mimo-v2.6-pro");
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger));
  const moved = { ...live, fingerprints: { ...live.fingerprints, proto: { module: "tuned", prompts: "tuned" } } };
  assert.throws(() => freeze(moved, dir, "tightened the card"), /proto_changed_in_round/);
  const frozen = freeze(live, dir);
  assert.equal(frozen.pilotCases, 0);
  assert.deepEqual(frozen.modelNames, { [mimo]: ["xiaomi/mimo-v2.6-pro"] });
  for (const path of [dir, root]) fs.rmSync(path, { recursive: true, force: true });
});
test("round evidence is the baseline's byte for byte; the baseline is pinned file by file and judged by its own definitions", () => {
  const { root, dir, basePlan, evidence, round, roundPlanT } = syntheticBaseline();
  assert.equal(baselineFiles(round).plan.planHash, basePlan.planHash);
  const reused = reuseEvidence(roundPlanT, round);
  assert.equal(reused.evidenceHash, evidence.evidenceHash); assert.equal(reused.planHash, roundPlanT.planHash);
  assert.deepEqual(reused.reusedFrom, { dir, planHash: basePlan.planHash, evidenceHash: evidence.evidenceHash });
  assert.equal(hash({ evidence: reused.evidence, sentences: reused.sentences, lWords: reused.lWords }), evidence.evidenceHash);
  // One appended byte anywhere in the archive refuses it.
  for (const name of Object.keys(round.baseline.files)) {
    const path = join(dir, name), original = fs.readFileSync(path);
    fs.appendFileSync(path, " "); assert.throws(() => baselineFiles(round), /baseline_changed/, name); fs.writeFileSync(path, original);
  }
  // Re-pinned but internally inconsistent: the evidence hash must still hold.
  const edited = { ...evidence, sentences: { charge: { sentence: "tuned" } } }; fs.writeFileSync(join(dir, "evidence.json"), JSON.stringify(edited));
  const repinned = structuredClone(round); repinned.baseline.files["evidence.json"] = fileSha(join(dir, "evidence.json"));
  assert.throws(() => baselineFiles(repinned), /baseline_changed/);
  fs.writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence));
  // A baseline plan edited under its old planHash (and re-pinned) is refused too.
  const loosened = { ...basePlan, thresholds: { ...basePlan.thresholds, harnessShareMax: 0.5 } }; fs.writeFileSync(join(dir, "plan.json"), JSON.stringify(loosened));
  const repinnedPlan = structuredClone(round); repinnedPlan.baseline.files["plan.json"] = fileSha(join(dir, "plan.json"));
  assert.throws(() => baselineFiles(repinnedPlan), /baseline_changed/);
  fs.writeFileSync(join(dir, "plan.json"), JSON.stringify(basePlan));
  // Judged by the baseline's rules: only the deadline may differ, and only to the round's.
  assert(checkBaselineDefinitions(roundPlanT, basePlan, round));
  for (const [edit, code] of [[p => p.thresholds = { ...p.thresholds, tokenRatio: 0.6 }, /baseline_definitions_thresholds/],
    [p => p.limits = { ...p.limits, httpPerCase: 3 }, /baseline_definitions_limits/], [p => p.limits = { ...p.limits, timeoutMs: 120000 }, /baseline_definitions_limits/],
    [p => p.criteria = p.criteria.slice(1), /baseline_definitions_criteria/], [p => p.phases.full.words = p.phases.full.words.slice(1), /baseline_definitions_phases/],
    [p => p.models[0].rates = { ...p.models[0].rates, output: p.models[0].rates.output * 2 }, /baseline_price_changed/]]) {
    const copy = structuredClone(roundPlanT); edit(copy);
    assert.throws(() => checkBaselineDefinitions(copy, basePlan, round), code, edit.toString());
  }
  fs.rmSync(root, { recursive: true, force: true });
});
test("prior ledgers: pinned by hash, settled only, and summed into exactly the round's per-model and total prior", () => {
  const { root, dir, ledger, round } = syntheticBaseline();
  assert(verifyPriorLedgers(round));
  // Beside the pinned ledgers sits no other ledger of the authorization (an
  // attempt of the round archived there would hand its spend back) but the
  // round's own; another experiment's ledger is not this authorization's.
  for (const [name, planBody] of [["dict-redesign-2026-10-26-timeout-180s-attempt1", null], ["renamed-run", { scope: AUTHORIZATION.scope }]]) {
    const extra = join(root, name); fs.mkdirSync(extra); fs.writeFileSync(join(extra, "ledger.json"), "{}");
    if (planBody) fs.writeFileSync(join(extra, "plan.json"), JSON.stringify(planBody));
    assert.throws(() => verifyPriorLedgers(round, join(root, "current")), /prior_ledger_unpinned/, name);
    assert(verifyPriorLedgers(round, extra), "the round's own directory is not an earlier ledger");
    fs.rmSync(extra, { recursive: true });
  }
  const other = join(root, "dict-litellm"); fs.mkdirSync(other);
  fs.writeFileSync(join(other, "ledger.json"), "{}"); fs.writeFileSync(join(other, "plan.json"), JSON.stringify({ scope: "dictionary-litellm-seven-models-2026-10-25" }));
  assert(verifyPriorLedgers(round, join(root, "current")));
  for (const [edit, code] of [[r => r.prior.ledgers[0].sha256 = "0".repeat(64), /prior_ledger_changed/], [r => r.prior.ledgers[0].spentMicros = 600, /prior_ledger_invalid/],
    [r => r.prior.totalMicros = 600, /prior_ledger_invalid/], [r => r.prior.models[ling] = 600, /prior_ledger_invalid/], [r => delete r.prior.models[glm], /prior_ledger_invalid/]]) {
    const copy = structuredClone(round); edit(copy); assert.throws(() => verifyPriorLedgers(copy), code, edit.toString());
  }
  // An unsettled reservation in an earlier ledger is refused even when re-pinned.
  const open = structuredClone(ledger); open.models[ling].attempts.push({ state: "reserved", reservedMicros: 900 });
  fs.writeFileSync(join(dir, "ledger.json"), JSON.stringify(open));
  const repinned = structuredClone(round); repinned.prior.ledgers[0].sha256 = fileSha(join(dir, "ledger.json"));
  assert.throws(() => verifyPriorLedgers(repinned), /prior_ledger_invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});
test("the judge is the archived frozen code: exactly the pinned files, with the baseline's driver and proto fingerprints", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-judge-")), code = join(dir, "frozen-code");
  const files = Object.keys(ROUND.baseline.code);
  for (const file of files) { fs.mkdirSync(dirname(join(code, file)), { recursive: true }); fs.copyFileSync(join(REPO_DIR, file), join(code, file)); }
  const current = codeFingerprints(), frozen = { fingerprints: { driver: current.driver, proto: current.proto } };
  const round = { ...plainOf(ROUND), baseline: { ...plainOf(ROUND.baseline), dir, code: Object.fromEntries(files.map(file => [file, fileSha(join(code, file))])) } };
  const judge = await baselineCode(round, frozen);
  assert.equal(typeof judge.summarize, "function"); assert.equal(typeof judge.blindReview, "function");
  fs.writeFileSync(join(code, "scripts/extra.mjs"), "export const planted = true;\n");
  await assert.rejects(baselineCode(round, frozen), /baseline_code_changed/, "no unpinned file may sit beside the frozen code");
  fs.rmSync(join(code, "scripts/extra.mjs"));
  await assert.rejects(baselineCode(round, { fingerprints: { ...frozen.fingerprints, driver: "other" } }), /baseline_code_changed/);
  await assert.rejects(baselineCode(round, { fingerprints: { ...frozen.fingerprints, proto: { module: "m", prompts: "q" } } }), /baseline_code_changed/);
  fs.appendFileSync(join(code, "dict-entry.js"), "\n");
  await assert.rejects(baselineCode(round, frozen), /baseline_code_changed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("the real archive matches the round's pins and its frozen code reproduces the archived main report", { skip: !fs.existsSync(join(REPO_DIR, ROUND.baseline.dir)) && "archive absent" }, async () => {
  const base = baselineFiles(); assert(verifyPriorLedgers());
  const judge = await baselineCode(ROUND, base.frozen), again = judge.sensitivity(base.plan, base.ledger, base.evidence);
  assert.deepEqual(plainOf({ ...again.main, sensitivity: { withoutWord: again.withoutWord, verdicts: again.verdictsWithout, changed: again.changed } }), base.report);
  assert.equal(judge.LIMITS.timeoutMs, 60000, "the main round ran at 60 s");
  assert.deepEqual(codeFingerprints().proto, plainOf(ROUND.baseline.proto), "the current prototype is the frozen one");
});
test("the real archive's judge is reproduced through the same entry point the live phases use", { skip: !fs.existsSync(join(REPO_DIR, ROUND.baseline.dir)) && "archive absent" }, async () => {
  const { base, judge } = await reproducedJudge();
  assert.equal(base.plan.planHash, ROUND.baseline.planHash); assert.equal(typeof judge.blindReview, "function");
  // ling and mimo answered under one upstream name each in the main round.
  const names = responseNames(base.ledger);
  assert.deepEqual(names[ling].names, ["inclusionai/ling-3.1-flash"]); assert.deepEqual(names[mimo].names, ["xiaomi/mimo-v2.6-pro"]);
});
test("the pinned product is the main round's plus exactly the two deadline edits", {
  skip: (!fs.existsSync(join(REPO_DIR, ROUND.baseline.dir)) && "archive absent") || (codeFingerprints().product !== ROUND.product && "the product has moved on since the round") }, () => {
  const read = file => fs.readFileSync(join(REPO_DIR, file), "utf8"), sha = text => createHash("sha256").update(text).digest("hex");
  const entryComment = "// One deadline for every model (no per-model branches): slow endpoints spend\n// thousands of hidden reasoning tokens, so 60 s cut off answers still in\n// progress (2026-10-26 comparison; user ruling: 180 s for all).\n";
  const aiComment = "// The ceiling admits the dictionary's 180 s deadline; anything outside the\n// range falls back to the 30 s default rather than waiting without bound.\n";
  const entry = read("dict-entry.js"), ai = read("ai.js");
  assert(entry.includes(entryComment) && entry.includes("timeoutMs: 180000,") && ai.includes(aiComment) && ai.includes("opts.timeoutMs <= 180000 ?"));
  const reverted = { "dict-entry.js": entry.replace(entryComment, "").replace("timeoutMs: 180000,", "timeoutMs: 60000,"),
    "ai.js": ai.replace(aiComment, "").replace("opts.timeoutMs <= 180000 ?", "opts.timeoutMs <= 120000 ?") };
  assert.equal(reverted["dict-entry.js"], read(join(ROUND.baseline.dir, "frozen-code/dict-entry.js")), "dict-entry.js differs from the frozen copy only by the deadline");
  const product = hash(productFiles().map(file => [file, sha(reverted[file] ?? fs.readFileSync(join(REPO_DIR, file)))]));
  assert.equal(product, baselineFiles().plan.fingerprints.product);
});
test("a merge needs the whole round: every planned probe and full case, none stopped, nothing halted", () => {
  const evidence = { lWords: { full: plan.lCandidates.slice(0, 4) } };
  const ledger = newLedger(roundPlan, "e"), planned = ["probe", "full"].flatMap(phase => plannedCases(roundPlan, phase, evidence));
  for (const item of planned) ledger.models[item.model].cases[item.caseId] = { ...item, outcome: "success" };
  assert.deepEqual(roundCompleteness(roundPlan, ledger, evidence), { complete: true, planned: 105, missing: [], stopped: [], halted: {} });
  const partial = structuredClone(ledger); delete partial.models[mimo].cases[planned.at(-1).caseId];
  assert.deepEqual(roundCompleteness(roundPlan, partial, evidence), { complete: false, planned: 105, missing: [planned.at(-1).caseId], stopped: [], halted: {} });
  const stopped = structuredClone(ledger); stopped.models[mimo].cases[planned[5].caseId].outcome = "stopped";
  assert.deepEqual(roundCompleteness(roundPlan, stopped, evidence), { complete: false, planned: 105, missing: [], stopped: [planned[5].caseId], halted: {} });
  const haltedModel = structuredClone(ledger); haltedModel.models[mimo].halted = "cost_limit_model";
  assert.deepEqual(roundCompleteness(roundPlan, haltedModel, evidence), { complete: false, planned: 105, missing: [], stopped: [], halted: { [mimo]: "cost_limit_model" } });
  const haltedRun = structuredClone(ledger); haltedRun.halted = "code_changed_during_run";
  assert.deepEqual(roundCompleteness(roundPlan, haltedRun, evidence), { complete: false, planned: 105, missing: [], stopped: [], halted: { ledger: "code_changed_during_run" } });
});
test("code guard: a change during a run halts the ledger for good, even if it is reverted", () => {
  const ledger = newLedger(plan, "e"); let saved = 0, now = structuredClone(fingerprints);
  const guard = codeGuard(structuredClone(fingerprints), ledger, () => saved++, () => now);
  guard(); assert.equal(ledger.halted, ""); assert.equal(saved, 0);
  now = { ...now, proto: { ...now.proto, prompts: "edited" } };
  assert.throws(guard, /code_changed_during_run/); assert.equal(ledger.halted, "code_changed_during_run"); assert.equal(saved, 1);
  now = structuredClone(fingerprints); guard();
  assert.equal(ledger.halted, "code_changed_during_run");
  assert.throws(() => reserve(plan, ledger, { model: glm, caseId: "next", inputBytes: 10, outputTokens: 10 }), /ledger_halted/);
});
test("supplementary C5/C6 use only words whose B click and all five A5 clicks succeeded", () => {
  const ledger = newLedger(plan, "e"), row = ledger.models[glm], words = plan.phases.full.words;
  const five = ["collocations", "confusables", "register", "grammar", "scenarios"];
  const put = (wordId, arm, category, outcome, prompt, output, latencyMs) => {
    const caseId = ["full", glm, wordId, arm, category].join(":");
    row.cases[caseId] = { caseId, phase: "full", model: glm, wordId, arm, category, outcome, latencyMs, usage: { prompt_tokens: prompt, completion_tokens: output, output_tokens: output } };
  };
  for (const id of words.slice(0, 6)) { put(id, "B", "card", "success", 300, 100, 4000); for (const c of five) put(id, "A", c, "success", 200, 100, 2000); }
  // A click cut off at the deadline (0 tokens, the deadline as its latency) leaves with its word.
  put(words[6], "B", "card", "failure", 0, 0, 60000); for (const c of five) put(words[6], "A", c, "success", 200, 100, 2000);
  put(words[7], "B", "card", "success", 300, 100, 4000); put(words[7], "A", "collocations", "failure", 0, 0, 60000);
  const summary = { models: Object.fromEntries(plan.models.map(m => [m.id, { harnessShare: 0 }])) };
  const result = successfulPairs(plan, ledger, summary);
  assert.deepEqual(result.models[glm], { words: 6, tokenRatio: 0.267, latencyRatio: 0.4, singleWaitRatio: 2, C5: true, C6: false });
  assert.deepEqual(result.models[gemini], { words: 0, tokenRatio: null, latencyRatio: null, singleWaitRatio: null, C5: false, C6: false });
  assert.deepEqual(result.C5, { verdict: "not_general", supportingModels: 1 });
  // Harness share above the threshold supports nothing, as in the registered rule.
  assert.equal(successfulPairs(plan, ledger, { models: { ...summary.models, [glm]: { harnessShare: 0.2 } } }).models[glm].C5, false);
});
test("prepare writes only its own, not yet started plan; live phases take no model or word subset", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-prepare-"));
  await assert.rejects(main(["--phase", "prepare", "--report-dir", dir, "--plan", join(tmpdir(), "elsewhere", "plan.json")]), /prepare_plan_path_fixed/);
  for (const name of ["ledger.json", "evidence.json", "frozen.json"]) {
    fs.writeFileSync(join(dir, name), "{}");
    await assert.rejects(main(["--phase", "prepare", "--report-dir", dir]), /live_scope_already_started/, name);
    fs.rmSync(join(dir, name));
  }
  for (const phase of ["evidence", "pilot", "freeze", "full"]) for (const flag of ["--models", "--words"])
    await assert.rejects(main(["--phase", phase, flag, ling]), /round_scope_fixed/, phase + " " + flag);
  fs.rmSync(dir, { recursive: true, force: true });
});
