#!/usr/bin/env node
// Revised dictionary comparison driver (redesign plan 1B.9, Q21=A).
//
// Built, never run: a live run needs its own explicit authorization (provider,
// models, data sent, request counts, retries, output caps and money caps), as
// CLAUDE.md "真实 AI API 测试" requires. The frozen driver
// scripts/dict-redesign-test.mjs stays archived unchanged as evidence; this
// one drives the redesigned reader UI (the "usage points" block with its two
// paid buttons, patterns and confusables, and the etymology block) and is
// pinned to the product code at the end of batch 1B.
//
// Modes:
//   --plan --config <public.json>   print the plan and an approval template
//   --live --config <public.json> --approval <approval.json>
//   --rehearse                      offline replay of handwritten responses
// --plan and --rehearse never read .env and never call an AI endpoint. Only
// --live, after every offline gate, reads exactly the configured key variable
// from ~/.config/ai-dev/.env with a dotenv parser; Chromium gets a placeholder.
// The endpoint, models, prices and caps are configuration; the word list,
// arms, limits, selectors and request gates are pre-registered here.
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { completionMetadata, completionReport, redactText } from "./dict-live-test.mjs";
import { boundedBody, requestInputBytes } from "./dict-litellm-test.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT = resolve(REPO, ".qa-scan/report/dict-redesign-r2");
// The account's own home, not $HOME: an edited environment cannot move the key file.
const KEY_FILE = resolve(userInfo().homedir, ".config/ai-dev/.env");
const DUMMY = "dict-redesign-r2-browser-placeholder";
const ACCOUNT = "dict_redesign_r2_fixture";
export const OWNER = "acct_" + ACCOUNT;

// sha256 over every runtime file the extension can load (productFiles()) as
// it stood at the end of batch 1B. Any later product change refuses --plan and
// --live (product_changed) until the pin is reviewed and moved on purpose.
export const PRODUCT_FINGERPRINT = "0df76fc61f9698e9ad6d470dce34cbe8351a5499123d041591ec826cfa712131";

export const SCOPE = "dictionary-redesign-r2";
export const ARMS = Object.freeze(["entry", "patterns", "confusables", "etymology"]);
// Which learning block holds each paid button (1B.8, Q8=A).
export const BLOCK_OF = Object.freeze({ patterns: "usage", confusables: "usage", etymology: "etymology" });
// The redesigned reader UI. These are what a user clicks; production code
// builds every request.
export const SELECTORS = Object.freeze({
  content: ".xp-dict-ai-content", senses: ".xp-dict-senses > li", entryGenerate: ".xp-dict-ai-generate",
  block: "[data-learning-block]", generate: ".xp-dict-supplement-generate", section: "[data-supplement-category]",
  text: ".xp-dict-supplement-text", actions: ".xp-dict-usage-actions", feedback: ".xp-dict-usage-feedback",
  errors: ".xp-dict-ai-status, .xp-dict-action-error"
});
// Each product prompt's opening, so a message can be tied to its arm.
const OPENINGS = Object.freeze({ entry: "Create a concise reusable dictionary entry", patterns: "Create one compact usage card",
  confusables: "Create a concise language-learning supplement", etymology: "Create a concise language-learning supplement" });
const w = (id, term, sourceLanguage, target, probes) => Object.freeze({ id, term, sourceLanguage, target, probes });
// The frozen round's holdout words, so figures stay comparable word by word.
export const WORDS = Object.freeze([
  w("charge", "charge", "en", "zh-Hans", "polysemy, sense granularity"),
  w("ran", "ran", "en", "zh-Hans", "inflected form"),
  w("take-off", "take off", "en", "zh-Hans", "phrasal verb"),
  w("notwithstanding", "notwithstanding", "en", "zh-Hans", "formal register"),
  w("bekommen", "bekommen", "de", "en", "false friend for English speakers"),
  w("embarazada", "embarazada", "es", "en", "false friend, Latin-script pair"),
  w("actuellement", "actuellement", "fr", "zh-Hans", "false friend (actually)"),
  w("magari", "magari", "it", "zh-Hans", "discourse particle"),
  w("davat", "давать", "ru", "zh-Hans", "aspect, government"),
  w("nunchi", "눈치", "ko", "zh-Hans", "culture-bound noun"),
  w("yabai", "やばい", "ja", "zh-Hans", "slang, register"),
  w("suibian", "随便", "zh", "en", "CJK source, English explanations")
]);
export const SYNTHETIC_PROFILE = Object.freeze({ "zh-Hans": "Simplified Chinese", en: "English" });
export const LIMITS = Object.freeze({ outputTokens: 8192, inputBytes: 24576, framingTokens: 1024, responseBytes: 262144,
  timeoutMs: 180000, httpPerCase: 4, retries: 0, wikimediaPerCase: 26, wikimediaBytes: 1800000 });
// Neutral answers: the model said there is nothing useful to add.
export const NEUTRAL = Object.freeze(["unsupported_usage"]);
// Harness states: test-tool failures, not product behaviour.
export const HARNESS = Object.freeze(["control_missing", "stale", "entry_unavailable", "target_preflight_failed", "owner_changed", "interrupted", "browser_case_failed"]);
// Bridge errors that halt the whole ledger, and those that stop one model.
const HALT_LEDGER = Object.freeze(["unauthorized_payload", "credential_routing_failed", "request_shape", "request_bounds", "ledger_invalid",
  "cost_limit_total", "usage_exceeds_reservation", "product_changed", "driver_changed"]);
const HALT_MODEL = Object.freeze(["cost_limit_model", "request_limit"]);
const BODY_FIELDS = Object.freeze(["model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "reasoning_effort", "response_format"]);
const CONFIG_FIELDS = Object.freeze(["schema", "endpoint", "keyVariable", "currency", "totalCap", "models", "words", "arms"]);
const MODEL_FIELDS = Object.freeze(["id", "cap", "inputPerMillion", "outputPerMillion", "priceSource", "priceVerifiedAt"]);
const PLAIN_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/+-]{0,199}$/;

export const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
export const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const slug = value => value.replace(/[^a-zA-Z0-9-]/g, "_");
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".pending", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".pending", path);
}
const environment = () => Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "FONTCONFIG_FILE", "DISPLAY"]
  .filter(name => typeof process.env[name] === "string").map(name => [name, process.env[name]]));

// HTTPS, or HTTP to a literal loopback host (the product's own endpoint rule).
export function checkBaseUrl(value) {
  let url; try { url = new URL(value); } catch { fail("endpoint_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) fail("endpoint_policy");
  return url.href.replace(/\/+$/, "");
}

// The public run configuration. Unknown fields, unsafe endpoints, unpriced or
// uncapped models and words outside the pre-registered list are refused.
export function validateConfig(raw) {
  if (!plainObject(raw) || raw.schema !== 1 || Object.keys(raw).some(key => !CONFIG_FIELDS.includes(key))) fail("config_invalid");
  const endpoint = checkBaseUrl(raw.endpoint);
  if (typeof raw.keyVariable !== "string" || !/^[A-Z][A-Z0-9_]{0,63}_API_KEY$/.test(raw.keyVariable)) fail("config_key_variable");
  if (!["USD", "CNY"].includes(raw.currency)) fail("config_currency");
  const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!positive(raw.totalCap)) fail("config_total_cap");
  if (!Array.isArray(raw.models) || !raw.models.length || raw.models.length > 8) fail("config_models");
  const models = raw.models.map(model => {
    if (!plainObject(model) || Object.keys(model).some(key => !MODEL_FIELDS.includes(key)) || MODEL_FIELDS.some(key => !own(model, key))) fail("config_model_fields");
    if (typeof model.id !== "string" || !PLAIN_MODEL.test(model.id)) fail("config_model_id");
    if (![model.cap, model.inputPerMillion, model.outputPerMillion].every(positive) || model.cap > raw.totalCap) fail("config_model_price");
    if (typeof model.priceSource !== "string" || !model.priceSource.trim() || typeof model.priceVerifiedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(model.priceVerifiedAt)) fail("config_model_price_source");
    return { id: model.id, cap: model.cap, inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion,
      priceSource: model.priceSource.trim(), priceVerifiedAt: model.priceVerifiedAt };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) fail("config_models");
  const words = raw.words === undefined ? WORDS.map(word => word.id) : raw.words;
  if (!Array.isArray(words) || !words.length || new Set(words).size !== words.length || words.some(id => !WORDS.some(word => word.id === id))) fail("config_words");
  const arms = raw.arms === undefined ? [...ARMS] : raw.arms;
  // Every supplement continues the base entry generated in the same run.
  if (!Array.isArray(arms) || new Set(arms).size !== arms.length || arms.some(arm => !ARMS.includes(arm)) || arms[0] !== "entry") fail("config_arms");
  return { endpoint, keyVariable: raw.keyVariable, currency: raw.currency, totalCap: raw.totalCap, models,
    words: WORDS.filter(word => words.includes(word.id)).map(word => word.id), arms: ARMS.filter(arm => arms.includes(arm)) };
}

// Product = every runtime file the extension can load (root html/js/css,
// manifest, locales, vendor), the same definition as the frozen driver.
export function productFiles(root = REPO) {
  const walk = dir => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(dir + "/" + entry.name) : [dir + "/" + entry.name]);
  const top = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:js|html|css)$|^manifest\.json$/.test(entry.name)).map(entry => entry.name);
  return [...top, ...walk("_locales"), ...walk("vendor")].sort();
}
const fileHash = (root, file) => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
export function productFingerprint(root = REPO) { return hash(productFiles(root).map(file => [file, fileHash(root, file)])); }
export const DRIVER_FILES = Object.freeze(["scripts/dict-redesign-test-r2.mjs", "scripts/dict-live-test.mjs", "scripts/dict-litellm-test.mjs"]);
export function driverFingerprint(root = REPO) { return hash(DRIVER_FILES.map(file => [file, fileHash(root, file)])); }
export function verifyProduct(actual) {
  if (actual !== PRODUCT_FINGERPRINT) fail("product_changed");
  return true;
}

export function makePlan(config, fingerprints) {
  const c = validateConfig(config);
  if (!/^[a-f0-9]{64}$/.test(fingerprints?.product || "") || !/^[a-f0-9]{64}$/.test(fingerprints?.driver || "")) fail("fingerprints_invalid");
  const plan = { schema: 1, scope: SCOPE, endpoint: c.endpoint, keyVariable: c.keyVariable, currency: c.currency, totalCap: c.totalCap,
    models: c.models, words: WORDS.filter(word => c.words.includes(word.id)), arms: c.arms,
    profile: { level: "intermediate", nativeLanguage: SYNTHETIC_PROFILE }, limits: LIMITS, neutral: NEUTRAL, harness: HARNESS,
    selectors: SELECTORS, blocks: BLOCK_OF, fingerprints: { product: fingerprints.product, driver: fingerprints.driver },
    sent: ["test word", "language pair", "the base entry generated by the same model in the same run", "public Wiktionary excerpts (etymology only)"],
    boundaries: {
      path: "Production library page: _pbpDictEntryMount, then the user's clicks on the AI entry button and on each learning block's paid button; production prompts, callAI, parsers and the IndexedDB archive. The driver builds no request.",
      requests: "Only POST " + c.endpoint + "/chat/completions with the configured model, one user message whose opening and trailing JSON payload match the case's arm and word, and the placeholder bearer. Anything else halts the run. Product dialect negotiation stays (at most " + LIMITS.httpPerCase + " HTTP per click), each request reserved and counted; the driver itself never retries.",
      wikimedia: "Etymology clicks only: anonymous GETs to the word language's exact Wiktionary /w/api.php, at most " + LIMITS.wikimediaPerCase + " per click; no AI.",
      money: "Before each dispatch the request's worst case (input bytes + framing at the input rate, its max output tokens at the output rate) is reserved and never refunded; it must fit the model cap and the total cap (" + c.currency + "). Prices are configuration from the ai-dev catalog, valid only on their verification UTC day.",
      credentials: "Only --live reads " + c.keyVariable + " from ~/.config/ai-dev/.env (fixed path) with a dotenv parser; an inherited variable of that name is refused; Chromium gets a placeholder.",
      code: "The product fingerprint must equal the pinned end-of-1B value, and product and driver fingerprints must stay unchanged during the run.",
      account: "Synthetic Pinboard owner " + OWNER + " in an isolated profile per model; Drive disconnected."
    } };
  return { ...plan, planHash: hash(plan) };
}

export function plannedCases(plan) {
  return plan.models.flatMap(model => plan.words.flatMap(word => plan.arms.map(arm =>
    ({ caseId: [model.id, word.id, arm].join(":"), model: model.id, wordId: word.id, arm }))));
}

export function validateApproval(plan, approval) {
  if (!plainObject(approval) || approval.authorized !== true || approval.planHash !== plan.planHash ||
      typeof approval.authorizationReference !== "string" || !approval.authorizationReference.trim() ||
      !Array.isArray(approval.models) || !approval.models.length || new Set(approval.models).size !== approval.models.length ||
      approval.models.some(id => !plan.models.some(model => model.id === id))) fail("approval_required_or_mismatched");
  return approval;
}

// Prices authorize only the UTC day on which they were verified.
export function validatePriceFreshness(plan, now = Date.now()) {
  let today; try { if (Number.isFinite(now)) today = new Date(now).toISOString().slice(0, 10); } catch {}
  if (!today || !plan.models.length || plan.models.some(model => model.priceVerifiedAt !== today)) fail("price_verification_expired");
  return true;
}

export function newLedger(plan) {
  return { schema: 1, scope: SCOPE, planHash: plan.planHash, halted: "", reservedMicros: 0,
    models: Object.fromEntries(plan.models.map(model => [model.id, { reservedMicros: 0, halted: "", attempts: [], cases: {} }])) };
}
export function validateLedger(plan, ledger) {
  if (!plainObject(ledger) || ledger.schema !== 1 || ledger.scope !== SCOPE || ledger.planHash !== plan.planHash) fail("ledger_plan_mismatch");
  const known = new Set(plannedCases(plan).map(item => item.caseId));
  let total = 0;
  for (const model of plan.models) {
    const row = ledger.models?.[model.id];
    if (!row || !Number.isSafeInteger(row.reservedMicros) || row.reservedMicros < 0 || !Array.isArray(row.attempts) || !plainObject(row.cases) ||
        row.attempts.some(a => !known.has(a.caseId) || !Number.isSafeInteger(a.reservedMicros) || a.reservedMicros < 0) ||
        Object.keys(row.cases).some(id => !known.has(id)) ||
        row.reservedMicros !== row.attempts.reduce((sum, a) => sum + a.reservedMicros, 0)) fail("ledger_invalid");
    total += row.reservedMicros;
  }
  if (ledger.reservedMicros !== total) fail("ledger_invalid");
  return ledger;
}

// Reserve before dispatch; a reservation is never released, whatever happens
// to the request. Money stays in the configured currency.
export function reserve(plan, ledger, { model: id, caseId, inputBytes, outputTokens }) {
  validateLedger(plan, ledger);
  const model = plan.models.find(item => item.id === id), row = ledger.models[id];
  if (!model || !plannedCases(plan).some(item => item.caseId === caseId && item.model === id) ||
      !Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > LIMITS.inputBytes ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > LIMITS.outputTokens) fail("request_bounds");
  if (row.attempts.filter(item => item.caseId === caseId).length >= LIMITS.httpPerCase) fail("request_limit");
  const reservedMicros = Math.ceil((inputBytes + LIMITS.framingTokens) * model.inputPerMillion + outputTokens * model.outputPerMillion);
  if (row.reservedMicros + reservedMicros > Math.floor(model.cap * 1e6)) fail("cost_limit_model");
  if (ledger.reservedMicros + reservedMicros > Math.floor(plan.totalCap * 1e6)) fail("cost_limit_total");
  const attempt = { n: row.attempts.length + 1, caseId, inputBytes, outputTokens, reservedMicros, state: "reserved", at: new Date().toISOString() };
  row.attempts.push(attempt); row.reservedMicros += reservedMicros; ledger.reservedMicros += reservedMicros;
  return attempt;
}
// Returned usage above what was reserved halts the run: a token cap is not a
// money guarantee, and the reservation arithmetic must stay an upper bound.
export function settle(attempt, usage = {}) {
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const output = Math.max(integer(usage.completion_tokens), integer(usage.total_tokens) - integer(usage.prompt_tokens));
  attempt.state = "received";
  if (output > attempt.outputTokens || integer(usage.prompt_tokens) > attempt.inputBytes + LIMITS.framingTokens) fail("usage_exceeds_reservation");
  return attempt;
}

// The request must be the product's own for the active case: known fields,
// the configured model, one user message opening with the arm's prompt and
// ending in a JSON payload about this word only.
export function authorizeRequest(plan, testCase, body) {
  const word = plan.words.find(item => item.id === testCase.wordId);
  if (!plainObject(body) || Object.keys(body).some(field => !BODY_FIELDS.includes(field)) || body.model !== testCase.model || body.stream ||
      !Array.isArray(body.messages) || body.messages.length !== 1 || body.messages[0]?.role !== "user" ||
      typeof body.messages[0].content !== "string" || (own(body, "max_tokens") && own(body, "max_completion_tokens"))) fail("request_shape");
  const content = body.messages[0].content, tokens = body.max_completion_tokens ?? body.max_tokens;
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > LIMITS.outputTokens) fail("request_bounds");
  let payload; try { payload = JSON.parse(content.split("\n").at(-1)); } catch { fail("unauthorized_payload"); }
  const bad = () => fail("unauthorized_payload");
  if (!word || !content.startsWith(OPENINGS[testCase.arm]) || !plainObject(payload) || payload.term !== word.term ||
      payload.sourceLanguage !== word.sourceLanguage || payload.targetLanguage?.lang !== word.target) bad();
  if (testCase.arm === "entry") {
    if (Object.keys(payload).sort().join() !== "sourceLanguage,targetLanguage,term") bad();
  } else {
    if (payload.baseEntry?.word !== word.term || payload.baseEntry?.language !== word.sourceLanguage) bad();
    if (testCase.arm === "patterns" ? payload.task !== "usage-card" : payload.category !== testCase.arm) bad();
    const origin = wiktionaryOrigin(word);
    const sources = payload.sources ?? [];
    if (!Array.isArray(sources) || (testCase.arm !== "etymology" && sources.length) ||
        sources.some(source => typeof source?.url !== "string" || !source.url.startsWith(origin + "/"))) bad();
  }
  return { tokens, field: own(body, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens" };
}
export const wiktionaryOrigin = word => "https://" + word.sourceLanguage.split("-")[0] + ".wiktionary.org";
export function wikimediaAllowed(url, word) {
  let parsed; try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === wiktionaryOrigin(word) && parsed.pathname === "/w/api.php" && !parsed.username && !parsed.password &&
    ["parse", "query"].includes(parsed.searchParams.get("action"));
}

// A case with requests but no record was interrupted: never re-send it.
export function resumeGuard(row, caseId) {
  return !row.cases[caseId] && row.attempts.some(item => item.caseId === caseId)
    ? { outcome: "harness", code: "interrupted", reason: "" } : null;
}
export function outcomeOf(result, attempts, bridgeError = "") {
  if (result?.ok) return { outcome: "success", code: "", reason: "" };
  const code = result?.error || "";
  if (HARNESS.includes(code)) return { outcome: "harness", code, reason: "" };
  if (NEUTRAL.includes(code)) return { outcome: "neutral", code, reason: result.reason || "" };
  if (bridgeError && (HALT_LEDGER.includes(bridgeError) || HALT_MODEL.includes(bridgeError))) return { outcome: "blocked", code: bridgeError, reason: "" };
  if (code) return { outcome: "failure", code, reason: result.reason || "" };
  if (result?.archived && !result.rendered) return { outcome: "failure", code: "render_failed", reason: "" };
  if (attempts.some(item => item.httpStatus >= 200 && item.httpStatus < 300)) return { outcome: "failure", code: "save_failed", reason: "" };
  return { outcome: "failure", code: bridgeError || "no_result", reason: "" };
}
export function summarize(plan, ledger) {
  const out = {};
  for (const model of plan.models) {
    const row = ledger.models[model.id];
    out[model.id] = { requests: row.attempts.length, reserved: row.reservedMicros / 1e6, currency: plan.currency, halted: row.halted || "",
      arms: Object.fromEntries(plan.arms.map(arm => {
        const cases = Object.values(row.cases).filter(item => item.arm === arm);
        const tally = cases.reduce((acc, item) => ({ ...acc, [item.outcome]: (acc[item.outcome] || 0) + 1 }), {});
        const codes = cases.filter(item => item.code).reduce((acc, item) => ({ ...acc, [item.code]: (acc[item.code] || 0) + 1 }), {});
        return [arm, { cases: cases.length, ...tally, codes, keptItems: cases.reduce((s, item) => s + (item.keptItems || 0), 0),
          omittedItems: cases.reduce((s, item) => s + (item.omittedItems || 0), 0),
          latencyMs: cases.reduce((s, item) => s + (item.latencyMs || 0), 0) }];
      })) };
  }
  return { planHash: plan.planHash, halted: ledger.halted || "", reserved: ledger.reservedMicros / 1e6, currency: plan.currency, models: out };
}

export function readKey(path, variable, env = process.env) {
  if (own(env, variable)) fail("inherited_key_conflict");
  const fields = parseEnv(readFileSync(path, "utf8"));
  const key = fields[variable];
  for (const name of Object.keys(fields)) delete fields[name];
  if (typeof key !== "string" || !key.trim()) fail("missing_" + variable);
  return key.trim();
}
function acquireLock(path) {
  try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); } catch { fail("ledger_locked"); }
  return () => { try { unlinkSync(path); } catch {} };
}

async function runModel(ctx, model) {
  const { plan, ledger, save, dispatch, wikimedia, key, outDir, verifyCode } = ctx;
  const row = ledger.models[model.id];
  const cases = plannedCases(plan).filter(item => item.model === model.id && !row.cases[item.caseId]);
  if (!cases.length || ledger.halted || row.halted) return;
  const { chromium } = createRequire(resolve(REPO, ".qa-scan/package.json"))("playwright");
  const context = await chromium.launchPersistentContext(resolve(outDir, "profiles", slug(model.id)), { headless: true,
    executablePath: chromium.executablePath(), env: environment(),
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"] });
  const endpoint = plan.endpoint + "/chat/completions", pending = new Set();
  let active = null; const bridge = { error: "", wikimedia: 0, blocked: 0 };
  const track = () => { let finish; const done = new Promise(resolve => { finish = resolve; }); pending.add(done); return () => { pending.delete(done); finish(); }; };
  try {
    verifyCode();
    await context.route(/^https?:/, async route => {
      const request = route.request(), url = request.url(), current = active;
      const word = current && plan.words.find(item => item.id === current.wordId);
      if (url !== endpoint) {
        if (current?.arm === "etymology" && request.method() === "GET" && wikimediaAllowed(url, word) && bridge.wikimedia < LIMITS.wikimediaPerCase) {
          bridge.wikimedia++; const release = track();
          try {
            const response = await wikimedia(url);
            await route.fulfill({ status: response.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
              body: await boundedBody(response, LIMITS.wikimediaBytes) });
          } catch { await route.abort().catch(() => {}); } finally { release(); }
          return;
        }
        bridge.blocked++; await route.abort().catch(() => {}); return;
      }
      const release = track(); let attempt, started;
      try {
        if (!current || request.method() !== "POST" || ledger.halted || row.halted) fail("unauthorized_payload");
        if (request.headers()["authorization"] !== "Bearer " + DUMMY) fail("credential_routing_failed");
        const body = request.postDataJSON();
        const { tokens } = authorizeRequest(plan, current, body);
        attempt = reserve(plan, ledger, { model: model.id, caseId: current.caseId, inputBytes: requestInputBytes(body), outputTokens: tokens });
        save(); // A crash after this line keeps the reservation.
        started = performance.now();
        const response = await dispatch(endpoint, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "Cache-Control": "no-store" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(LIMITS.timeoutMs) });
        const text = redactText(await boundedBody(response, LIMITS.responseBytes), [key]);
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
        const meta = completionMetadata(parsed);
        Object.assign(attempt, meta, { httpStatus: response.status, latencyMs: Math.round(performance.now() - started) });
        // Only a 2xx answer's text is kept, redacted, for review; never reasoning, headers or provider errors.
        const answer = response.ok ? completionReport(parsed, [key]) : null;
        if (answer) { attempt.answer = slug(current.caseId) + "-" + attempt.n + ".json"; writeJson(resolve(outDir, "answers", attempt.answer), { caseId: current.caseId, ...answer }); }
        settle(attempt, meta.usage); save();
        await route.fulfill({ status: response.status, contentType: "application/json", body: text });
      } catch (error) {
        bridge.error = error?.safeCode || (error?.name === "TimeoutError" ? "transport_timeout" : "transport_failed");
        if (attempt) { attempt.state = attempt.state === "received" ? "received" : "failed_or_uncertain"; attempt.failure = bridge.error;
          if (started !== undefined && !Number.isFinite(attempt.latencyMs)) attempt.latencyMs = Math.round(performance.now() - started); }
        if (HALT_LEDGER.includes(bridge.error)) ledger.halted ||= bridge.error;
        if (HALT_MODEL.includes(bridge.error)) row.halted ||= bridge.error;
        save(); await route.abort().catch(() => {});
      } finally { release(); }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(worker.url()).hostname;
    for (const target of [...new Set(plan.words.map(word => word.target))]) {
      const targetCases = cases.filter(item => plan.words.find(word => word.id === item.wordId).target === target);
      if (!targetCases.length || ledger.halted || row.halted) continue;
      await worker.evaluate(async ({ model, dummy, base, target, native, token }) => {
        if (typeof primeSettings === "function") await primeSettings();
        await chrome.storage.local.set({ optSyncEnabled: false, syncApiKeys: false, optLang: "zh_CN", previewAiEnabled: true,
          pinboardToken: obfuscateKey(token), _hlOwnerClaimDone: true, aiProvider: "custom", customApiKey: obfuscateKey(dummy),
          customModel: model, customBaseUrl: base, previewAiModelByProvider: {}, dictDefaultView: "ai-saved", dictDefinitionLang: target,
          dictLearnerNativeLanguage: native, dictLearnerLevel: "intermediate" });
      }, { model: model.id, dummy: DUMMY, base: plan.endpoint, target, native: plan.profile.nativeLanguage[target], token: ACCOUNT + ":nonsecret_synthetic_token" });
      const page = await context.newPage();
      await page.goto("chrome-extension://" + extensionId + "/library.html#vocab");
      await page.waitForFunction(() => typeof _pbpDictEntryMount === "function" && typeof pbpDictSupplementRun === "function" &&
        typeof pbpDictEntryRun === "function" && typeof callAI === "function" && typeof _pbpDictFailureCode === "function");
      await page.evaluate(({ allowed }) => {
        const set = new Set(allowed);
        chrome.permissions.contains = async ({ origins }) => origins.every(origin => set.has(origin.replace(/\/\*$/, "")));
        chrome.permissions.request = chrome.permissions.contains;
        window.r2State = { calls: 0, pending: 0, actions: 0, actionPending: 0, error: "", reason: "" };
        const original = callAI;
        callAI = async (...args) => { r2State.calls++; r2State.pending++; try { return await original(...args); } finally { r2State.pending--; } };
        const wrap = run => async (...args) => {
          r2State.actions++; r2State.actionPending++;
          try { return await run(...args); }
          catch (error) { r2State.error = _pbpDictFailureCode(error); r2State.reason = _pbpDictFailureReason(error); throw error; }
          finally { r2State.actionPending--; }
        };
        pbpDictEntryRun = wrap(pbpDictEntryRun); pbpDictSupplementRun = wrap(pbpDictSupplementRun);
      }, { allowed: [new URL(plan.endpoint).origin, ...plan.words.map(wiktionaryOrigin)] });
      verifyCode();
      const preflight = await page.evaluate(async () => {
        const owner = await pbpVocabCurrentOwner();
        const sync = await chrome.runtime.sendMessage({ type: "PBP_DICT_ARCHIVE_SYNC", owner });
        return { owner, ok: sync?.ok === true, connected: sync?.connected === true };
      });
      if (preflight.owner !== OWNER || !preflight.ok || preflight.connected) fail("archive_isolation_failed");
      for (const testCase of targetCases) {
        if (ledger.halted || row.halted) break;
        const interrupted = resumeGuard(row, testCase.caseId);
        if (interrupted) { row.cases[testCase.caseId] = { ...testCase, ...interrupted }; save(); continue; }
        const word = plan.words.find(item => item.id === testCase.wordId);
        const entryCase = row.cases[[model.id, word.id, "entry"].join(":")];
        if (testCase.arm !== "entry" && entryCase?.outcome !== "success") {
          row.cases[testCase.caseId] = { ...testCase, outcome: "harness", code: "entry_unavailable", reason: "" }; save(); continue;
        }
        active = testCase; bridge.error = ""; bridge.wikimedia = 0;
        const started = performance.now();
        let result;
        try {
          result = await runCase(page, word, testCase.arm);
          await Promise.allSettled([...pending]);
        } catch (error) {
          // The click is over for this run: record it so a resume never re-sends it.
          await Promise.allSettled([...pending]);
          row.cases[testCase.caseId] = { ...testCase, outcome: "harness", code: "interrupted", reason: typeof error?.safeCode === "string" ? error.safeCode : error?.name || "" };
          active = null; save(); throw error;
        }
        active = null;
        const attempts = row.attempts.filter(item => item.caseId === testCase.caseId);
        const value = result.value || {};
        row.cases[testCase.caseId] = { ...testCase, ...outcomeOf(result, attempts, bridge.error),
          keptItems: testCase.arm === "entry" ? value.meanings || 0 : value.items || 0, omittedItems: value.omittedItems || 0,
          sources: value.sources || 0, feedback: result.feedback || "", wikimediaRequests: bridge.wikimedia,
          latencyMs: attempts.reduce((sum, item) => sum + (item.latencyMs || 0), 0), wallMs: Math.round(performance.now() - started) };
        if (result.content) writeJson(resolve(outDir, "content", slug(testCase.caseId) + ".json"), { caseId: testCase.caseId, content: result.content });
        save();
        process.stdout.write(JSON.stringify({ case: testCase.caseId, outcome: row.cases[testCase.caseId].outcome, code: row.cases[testCase.caseId].code || undefined }) + "\n");
        verifyCode();
      }
      await page.close();
    }
  } finally {
    await Promise.allSettled([...pending]);
    await context.close();
  }
}

// Mount the production entry panel, click the arm's control exactly as a user
// does, wait for the product to settle, then read the archive and the DOM.
async function runCase(page, word, arm) {
  const mounted = await page.evaluate(async ({ word, arm, owner, sel, block }) => {
    // The same settings object the library hands the panel (library-vocab.js).
    const settings = deobfuscateSettings(await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS));
    if (await pbpVocabCurrentOwner() !== owner) return { error: "owner_changed" };
    const target = pbpDictLearningTarget(settings, "zh-CN");
    if (target.lang !== word.target) return { error: "target_preflight_failed" };
    const host = document.createElement("section"); host.className = "library-dict"; document.body.replaceChildren(host);
    const mount = _pbpDictEntryMount(host, { term: word.term, lang: word.sourceLanguage, owner, settings, isCurrent: () => true });
    await mount.ready; mount.show("ai");
    window.r2Host = host;
    window.r2Request = { term: word.term, sourceLanguage: word.sourceLanguage, target, owner, settings, isCurrent: () => true };
    const record = await pbpDictArchiveRead(r2Request);
    const live = rec => { const replaced = new Set((rec?.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
      return (rec?.supplements || []).find(item => item.category === arm && !replaced.has(item.id)); };
    if (arm === "entry" ? !!record : !record?.archiveId) return { error: arm === "entry" ? "stale" : "entry_unavailable" };
    if (arm !== "entry" && live(record)) return { error: "stale" };
    const control = () => arm === "entry" ? host.querySelector(sel.entryGenerate)
      : host.querySelector(sel.block.slice(0, -1) + '="' + block + '"] ' + sel.generate + '[data-category="' + arm + '"]');
    for (let tries = 0; tries < 50 && !(control() && !control().hidden && !control().disabled && control().checkVisibility()); tries++) {
      await new Promise(done => setTimeout(done, 100));
    }
    const button = control();
    if (!button || button.hidden || button.disabled || !button.checkVisibility()) return { error: "control_missing" };
    Object.assign(r2State, { calls: 0, pending: 0, actions: 0, actionPending: 0, error: "", reason: "" });
    button.click();
    return { clicked: true };
  }, { word, arm, owner: OWNER, sel: SELECTORS, block: BLOCK_OF[arm] || "" });
  if (!mounted.clicked) return { ok: false, error: mounted.error || "control_missing" };
  await page.waitForFunction(() => (r2State.actions > 0 || r2State.error) && r2State.actionPending === 0 && r2State.pending === 0,
    null, { timeout: LIMITS.timeoutMs * LIMITS.httpPerCase + 30000, polling: 250 });
  return page.evaluate(async ({ arm, sel, block }) => {
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const host = r2Host, record = await pbpDictArchiveRead(r2Request);
    const visible = node => !!node && node.checkVisibility({ checkVisibilityCSS: true }) && node.getBoundingClientRect().height > 0;
    const content = host.querySelector(sel.content);
    const errors = [...host.querySelectorAll(sel.errors)].filter(node => visible(node) && node.textContent.trim()).length;
    const state = { error: r2State.error, reason: r2State.reason, calls: r2State.calls };
    if (arm === "entry") {
      const entry = record?.entry, meanings = [...host.querySelectorAll(sel.senses)].filter(visible).length;
      const rendered = visible(content) && !!entry && meanings === entry.meanings.length && meanings > 0 &&
        content.textContent.includes(entry.meanings[0].definition) && !errors;
      return { ok: !!entry && rendered && state.calls > 0 && !state.error, archived: !!entry, rendered, ...state,
        value: { meanings: entry?.meanings.length || 0 }, content: entry || null };
    }
    const replaced = new Set((record?.supplements || []).map(item => item.learning?.replacesId).filter(Boolean));
    const saved = (record?.supplements || []).find(item => item.category === arm && !replaced.has(item.id));
    const blockEl = host.querySelector(sel.block.slice(0, -1) + '="' + block + '"]');
    const section = saved && blockEl?.querySelector(":scope > " + sel.section.slice(0, -1) + '="' + arm + '"][data-supplement-id="' + CSS.escape(saved.id) + '"]');
    const shown = saved?.learning?.items?.[0]?.explanation;
    const rendered = visible(section) && !!shown && !!section.querySelector(sel.text)?.textContent.includes(shown);
    // The button's own feedback line (saved / partial / error), read for its state only.
    const feedback = blockEl?.querySelector(sel.generate + '[data-category="' + arm + '"]')?.closest(sel.actions)?.querySelector(sel.feedback)?.dataset.state || "";
    return { ok: !!saved && rendered && state.calls > 0 && !state.error, archived: !!saved, rendered, feedback, ...state,
      value: saved ? { items: saved.learning.items.length, omittedItems: saved.learning.omittedItems || 0, sources: (saved.sources || []).length } : null,
      content: saved ? { learning: saved.learning, sources: (saved.sources || []).map(source => ({ title: source.title, url: source.url })) } : null };
  }, { arm, sel: SELECTORS, block: BLOCK_OF[arm] || "" }).catch(() => ({ ok: false, error: "browser_case_failed" }));
}

async function runPlan(plan, { outDir, key, dispatch, wikimedia, approvedModels, fingerprints }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const ledgerPath = resolve(outDir, "ledger.json");
  const ledger = existsSync(ledgerPath) ? validateLedger(plan, JSON.parse(readFileSync(ledgerPath, "utf8"))) : newLedger(plan);
  if (ledger.halted) fail("ledger_halted");
  const save = () => writeJson(ledgerPath, ledger); save();
  const verifyCode = () => {
    const now = fingerprints();
    const changed = now.product !== plan.fingerprints.product ? "product_changed" : now.driver !== plan.fingerprints.driver ? "driver_changed" : "";
    if (changed) { ledger.halted ||= changed; save(); fail(changed); }
  };
  for (const model of plan.models.filter(item => approvedModels.includes(item.id))) {
    await runModel({ plan, ledger, save, dispatch, wikimedia, key, outDir, verifyCode }, model);
    if (ledger.halted) break;
  }
  const report = summarize(plan, ledger);
  writeJson(resolve(outDir, "report.json"), report);
  return { ledger, report };
}

// Offline replay: a built-in synthetic configuration and handwritten
// responses. Never reads the config directory or .env, never calls Node fetch.
export const REHEARSAL_CONFIG = Object.freeze({ schema: 1, endpoint: "https://rehearsal.invalid/v1", keyVariable: "REHEARSAL_API_KEY",
  currency: "USD", totalCap: 1, words: ["charge"],
  models: [{ id: "rehearsal/model-a", cap: 0.5, inputPerMillion: 1, outputPerMillion: 2, priceSource: "synthetic", priceVerifiedAt: "2026-10-27" }] });

export async function main(argv = process.argv.slice(2), inject = {}) {
  const option = name => { const at = argv.indexOf(name); return at < 0 ? "" : argv[at + 1] || ""; };
  const fingerprints = inject.fingerprints || (() => ({ product: productFingerprint(), driver: driverFingerprint() }));
  const print = value => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  if (argv.includes("--rehearse")) {
    if (argv.includes("--live") || argv.includes("--plan")) fail("conflicting_modes");
    const current = fingerprints(), plan = makePlan(REHEARSAL_CONFIG, current);
    const { responseFor, wikimediaResponse } = await import("../tests/fixtures/dict-redesign-r2-responses.mjs");
    mkdirSync(REPORT, { recursive: true, mode: 0o700 });
    const outDir = mkdtempSync(resolve(REPORT, "rehearsal-"));
    const dispatch = async (_url, options) => new Response(JSON.stringify(responseFor(JSON.parse(options.body))),
      { status: 200, headers: { "Content-Type": "application/json" } });
    const wikimedia = async url => new Response(JSON.stringify(wikimediaResponse(url)), { status: 200, headers: { "Content-Type": "application/json" } });
    const { ledger, report } = await runPlan(plan, { outDir, key: "synthetic-rehearsal-key", dispatch, wikimedia,
      approvedModels: plan.models.map(model => model.id), fingerprints });
    const ok = plannedCases(plan).every(item => ledger.models[item.model].cases[item.caseId]?.outcome === "success");
    print({ rehearsal: true, liveRequests: 0, productPinned: current.product === PRODUCT_FINGERPRINT, outDir, ok, report, ledger });
    if (!ok) process.exitCode = 1;
    return;
  }
  const configPath = option("--config"); if (!configPath) fail("config_required");
  const plan = makePlan(JSON.parse(readFileSync(resolve(configPath), "utf8")), fingerprints());
  verifyProduct(plan.fingerprints.product);
  if (!argv.includes("--live")) {
    print({ plan, cases: plannedCases(plan).length, approvalTemplate: { authorized: false, planHash: plan.planHash, authorizationReference: "",
      models: plan.models.map(model => model.id) } });
    return;
  }
  validatePriceFreshness(plan, inject.now ?? Date.now());
  const approvalPath = option("--approval"); if (!approvalPath) fail("approval_required_or_mismatched");
  const approval = validateApproval(plan, JSON.parse(readFileSync(resolve(approvalPath), "utf8")));
  const outDir = resolve(REPORT, plan.planHash.slice(0, 16));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(resolve(outDir, "ledger.lock"));
  try {
    // Every offline gate has passed; this is the only credential read.
    const key = readKey(inject.keyFile || KEY_FILE, plan.keyVariable);
    const { report } = await runPlan(plan, { outDir, key, dispatch: inject.dispatch || fetch, approvedModels: approval.models, fingerprints,
      wikimedia: inject.wikimedia || (url => fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000) })) });
    print(report);
  } finally { unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write("[dict-redesign-test-r2] " + (typeof error?.safeCode === "string" && /^[a-zA-Z0-9_]+$/.test(error.safeCode) ? error.safeCode : "preflight_or_harness_failed") + "\n"); process.exitCode = 1; });
}
