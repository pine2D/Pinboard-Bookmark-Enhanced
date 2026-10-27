// Offline browser integration for the redesign driver: the whole A/B/L/R flow
// (evidence -> pilot -> freeze -> full -> report) with every .env probe and
// every Node network dispatch forbidden. Chromium resolves no host at all;
// handwritten fixtures own all Wikimedia and model answers.
// Run separately from the fast guard suite because Chromium needs subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

let secretAttempts = 0, configAttempts = 0, networkAttempts = 0, output = "";
for (const name of ["readFileSync", "statSync", "existsSync", "openSync", "readFile", "createReadStream"]) {
  const original = fs[name];
  fs[name] = function(path, ...args) {
    if (/(?:^|\/)\.env$/.test(String(path))) { secretAttempts++; throw new Error("FORBIDDEN_SECRET_ACCESS"); }
    if (/\/\.config\/ai-dev\//.test(String(path))) { configAttempts++; throw new Error("FORBIDDEN_USER_CONFIG_ACCESS"); }
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch = () => { networkAttempts++; throw new Error("FORBIDDEN_NETWORK"); };
const { main, makePlan, codeFingerprints, plannedCases, ROUND, roundReport } = await import("../scripts/dict-redesign-test.mjs");
const { prices } = await import("./fixtures/dict-redesign-prices.mjs");
const reportDir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-rehearsal-"));
const models = ["commandcode/glm-5.3-flash", "commandcode/mimo-v2.6-pro", "commandcode/gemini-3.8-flash"];
const words = ["provider", "based", "charge", "notwithstanding", "nunchi", "suibian"];
const write = process.stdout.write.bind(process.stdout);
try {
  const plan = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: codeFingerprints() });
  fs.writeFileSync(join(reportDir, "plan.json"), JSON.stringify(plan));
  process.stdout.write = chunk => { output += chunk; return true; };
  try {
    await main(["--phase", "rehearse", "--report-dir", reportDir, "--concurrency", "2", "--models", models.join(","),
      "--words", words.join(",")]);
  } finally { process.stdout.write = write; }
  const summary = JSON.parse(output.slice(output.lastIndexOf("\n{\n") + 1));
  const ledger = JSON.parse(fs.readFileSync(join(summary.rehearsalDirectory, "ledger.json"), "utf8"));
  const cases = Object.values(ledger.models).flatMap(row => Object.values(row.cases));
  const byId = id => cases.find(row => row.caseId === id);
  const gemini0 = "commandcode/gemini-3.8-flash";
  assert.equal(summary.realRequests, 0);
  assert.deepEqual(summary.lWords, { pilot: ["provider"], full: ["notwithstanding", "charge", "davat", "magari"] });
  assert.equal(summary.census.etymology.source_failed, 1, "ko fixture returns HTTP 503");
  // pilot: glm only (gemini/mimo are not pilot models) x provider(8+2) + based(8)
  assert.equal(cases.filter(row => row.phase === "pilot").length, 18);
  // probe: one base entry on provider for each selected model, own profile, recorded not checked.
  const probes = cases.filter(row => row.phase === "probe");
  assert.deepEqual(probes.map(row => row.caseId).sort(), models.map(id => "probe:" + id + ":provider:entry").sort());
  assert(probes.every(row => row.arm === "entry" && row.outcome === "success" && row.costMicros > 0), "probe requests are billed in the ledger");
  assert(!Object.values(ledger.entries).some(words => Object.values(words).some(entry => entry.caseId.startsWith("probe:"))), "the probe entry is never frozen for an arm");
  const frozenFile = JSON.parse(fs.readFileSync(join(summary.rehearsalDirectory, "frozen.json"), "utf8"));
  assert.deepEqual(frozenFile.modelNames, { "commandcode/glm-5.3-flash": ["commandcode/glm-5.3-flash"], "commandcode/mimo-v2.6-pro": ["xiaomi/mimo-v2.6-pro-preview"],
    "commandcode/gemini-3.8-flash": ["commandcode/gemini-3.8-flash"], "commandcode/deepseek-v4.1-flash": [], "commandcode/minimax-m3.1-flash": [],
    "commandcode/ling-3.1-flash": [], "commandcode/claude-haiku-5-5": [] });
  assert.deepEqual(frozenFile.probes["commandcode/mimo-v2.6-pro"].aliases, ["xiaomi/mimo-v2.6-pro-preview"]);
  // mimo answers every full request under its registered alias and is never stopped.
  const mimo = "commandcode/mimo-v2.6-pro";
  assert.equal(ledger.models[mimo].halted, "");
  assert(ledger.models[mimo].attempts.filter(a => a.httpStatus === 200).every(a => a.responseModel === "xiaomi/mimo-v2.6-pro-preview"));
  assert.equal(cases.filter(row => row.model === mimo && row.phase === "full").length, 4 * 8 + 2 * 2);
  // Negotiation: mimo refuses response_format once per profile (probe, full); counted apart in ledger and report.
  assert.equal(ledger.models[mimo].negotiationResends, 2);
  assert.deepEqual(summary.negotiation[mimo].byPhase, { probe: 1, full: 1 });
  assert.deepEqual(summary.negotiation[mimo].changed, { response_format: 2 }); assert.deepEqual(summary.negotiation[mimo].afterStatus, { 400: 2 });
  assert.equal(summary.negotiation["commandcode/glm-5.3-flash"].resends, 0); assert.equal(summary.negotiation[gemini0].resends, 0);
  assert(ledger.models[mimo].attempts.filter(a => a.negotiation).every(a => a.negotiation.removed[0] === "response_format" && a.negotiation.after === 400));
  assert(cases.filter(row => row.phase === "pilot").every(row => row.model === "commandcode/glm-5.3-flash"));
  // full: 3 models x 4 words x 8 arms + L on charge/notwithstanding (2 arms),
  // minus gemini's suibian cases after the response-model mismatch stop.
  const gemini = gemini0;
  const geminiSuibian = plannedCases(plan, "full", { lWords: summary.lWords }).filter(c => c.model === gemini && c.wordId === "suibian");
  const stopAt = geminiSuibian.findIndex(c => c.caseId === "full:" + gemini + ":suibian:A:grammar");
  assert(stopAt > 0);
  assert.equal(cases.filter(row => row.phase === "full").length, 3 * 4 * 8 + 3 * 2 * 2 - (geminiSuibian.length - stopAt - 1));
  assert.equal(ledger.models[gemini].halted, "gateway_model_mismatch");
  assert.equal(byId("full:" + gemini + ":suibian:A:grammar").outcome, "stopped");
  assert.equal(byId("full:" + gemini + ":suibian:A:grammar").responseModels.at(-1), "commandcode/gemini-3.8-flash-lite");
  // Billing counts output hidden in total_tokens (Gemini-compat usage).
  const card = ledger.models[gemini].attempts.find(item => item.caseId === "full:" + gemini + ":charge:B");
  assert.equal(card.billedOutputTokens, 4620 - 1100);
  // C6 clock: HTTP latency only, the same for both arms; tool overhead apart.
  assert(cases.filter(row => row.http > 0).every(row => Number.isFinite(row.latencyMs) && Number.isFinite(row.harnessMs) && Number.isFinite(row.wallMs)));
  // Duplicate proxy is exercised: A shares one example between two categories, B only for charge.
  const report = JSON.parse(fs.readFileSync(join(summary.rehearsalDirectory, "report.json"), "utf8"));
  assert.equal(report.models["commandcode/glm-5.3-flash"].derived.dupA, 0.4);
  assert(report.models["commandcode/glm-5.3-flash"].derived.dupB > 0 && report.models["commandcode/glm-5.3-flash"].derived.dupB < 0.4);
  assert(Array.isArray(report.sensitivity.changed));
  for (const name of ["literature", "usage", "duplicates"]) assert(fs.existsSync(join(summary.rehearsalDirectory, "review-" + name + ".json")));
  const dupSheet = JSON.parse(fs.readFileSync(join(summary.rehearsalDirectory, "review-key-duplicates.json"), "utf8"));
  assert(dupSheet.some(row => row.arm === "A") && dupSheet.some(row => row.arm === "B"));
  const mixed = byId("full:commandcode/mimo-v2.6-pro:charge:B");
  assert.equal(mixed.outcome, "success"); assert.equal(mixed.keptItems, 2); assert.equal(mixed.droppedItems[0].reason, "wrong_language");
  assert.equal(byId("full:commandcode/gemini-3.8-flash:nunchi:entry").layer, "empty");
  assert.equal(byId("full:commandcode/gemini-3.8-flash:nunchi:B").outcome, "blocked");
  assert.equal(byId("full:commandcode/glm-5.3-flash:nunchi:A:etymology").layer, "evidence");
  assert.equal(byId("full:commandcode/glm-5.3-flash:suibian:B").outcome, "success");
  assert.equal(byId("full:commandcode/glm-5.3-flash:notwithstanding:L-B").sentence, "Notwithstanding the rain, she would not stay at home.");
  assert(cases.filter(row => row.outcome === "success" && row.arm !== "B" && row.arm !== "L-B").every(row => row.http === 1 + row.negotiationResends && row.costMicros > 0));
  // Every attempt settled: usage, or (negotiation 400 refusals only) the input bound.
  assert(Object.values(ledger.models).every(row => row.attempts.every(item => item.state === "settled" &&
    (item.costBasis === "usage" || (item.costBasis === "rejected_input_bound" && item.httpStatus === 400 && row === ledger.models[mimo])))));
  const report0 = JSON.parse(fs.readFileSync(join(summary.rehearsalDirectory, "report.json"), "utf8"));
  assert.deepEqual(report0.negotiation[mimo].byPhase, { probe: 1, full: 1 }, "report.json lists negotiation per model");
  assert.equal(report0.budget.stopUSD, 9.6);
  assert.equal(fs.existsSync(join(reportDir, "ledger.json")), false, "rehearsal never creates the live ledger");
  const raw = fs.readdirSync(join(summary.rehearsalDirectory, "raw"));
  assert.equal(raw.length, Object.values(ledger.models).reduce((sum, row) => sum + row.attempts.length, 0));
  // ---- Round rehearsal: the run above, archived with a copy of this code, is the baseline ----
  const REPO = join(dirname(fileURLToPath(import.meta.url)), ".."), base = summary.rehearsalDirectory;
  const sha = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex"), glm = "commandcode/glm-5.3-flash";
  const codeFiles = ["scripts/dict-redesign-test.mjs", "scripts/dict-live-test.mjs", "scripts/dict-litellm-test.mjs", "scripts/dict-redesign-proto.mjs",
    "tests/fixtures/dict-evidence-harness.html", "dict-entry.js", "dict-evidence.js"];
  for (const file of codeFiles) { fs.mkdirSync(dirname(join(base, "frozen-code", file)), { recursive: true }); fs.copyFileSync(join(REPO, file), join(base, "frozen-code", file)); }
  const baseReport = JSON.parse(fs.readFileSync(join(base, "report.json"), "utf8"));
  const testRound = { id: "rehearsal", models: [glm, mimo], caps: { [mimo]: 2 }, timeoutMs: ROUND.timeoutMs, product: codeFingerprints().product,
    baseline: { dir: base, planHash: plan.planHash, evidenceHash: ledger.evidenceHash, frozenHash: ledger.frozenHash,
      files: Object.fromEntries(["plan.json", "ledger.json", "evidence.json", "frozen.json", "report.json"].map(name => [name, sha(join(base, name))])),
      code: Object.fromEntries(codeFiles.map(file => [file, sha(join(base, "frozen-code", file))])), proto: frozenFile.fingerprints.proto },
    prior: { root: reportDir, ledgers: [{ dir: base, sha256: sha(join(base, "ledger.json")), spentMicros: ledger.spentMicros }],
      models: Object.fromEntries(Object.entries(ledger.models).map(([id, row]) => [id, row.spentMicros])), totalMicros: ledger.spentMicros } };
  const roundDir = fs.mkdtempSync(join(tmpdir(), "dict-redesign-round-rehearsal-"));
  let roundCases = 0;
  try {
    const roundPlan = makePlan({ prices, baseUrl: "http://127.0.0.1:48097/v1", fingerprints: codeFingerprints(), round: testRound });
    fs.writeFileSync(join(roundDir, "plan.json"), JSON.stringify(roundPlan));
    output = "";
    process.stdout.write = chunk => { output += chunk; return true; };
    try {
      await main(["--phase", "rehearse", "--report-dir", roundDir, "--concurrency", "2"], { round: testRound });
    } finally { process.stdout.write = write; }
    const rs = JSON.parse(output.slice(output.lastIndexOf("\n{\n") + 1)), dir = rs.rehearsalDirectory;
    const rLedger = JSON.parse(fs.readFileSync(join(dir, "ledger.json"), "utf8")), rEvidence = JSON.parse(fs.readFileSync(join(dir, "evidence.json"), "utf8"));
    const rCases = Object.values(rLedger.models).flatMap(row => Object.values(row.cases)); roundCases = rCases.length;
    assert.deepEqual(Object.keys(rLedger.models).sort(), [glm, mimo]);
    assert.equal(rs.evidenceRequests, 0); assert.equal(rEvidence.evidenceHash, ledger.evidenceHash); assert.equal(rEvidence.reusedFrom.planHash, plan.planHash);
    assert.equal(rCases.filter(row => row.phase === "pilot").length, 0); assert.equal(rs.frozenPilotCases, 0);
    assert.deepEqual(rCases.filter(row => row.phase === "probe").map(row => row.caseId).sort(), [glm, mimo].map(id => "probe:" + id + ":provider:entry").sort());
    // full: every planned case, both models x 12 holdout words x 8 arms + 4 literature words x 2 arms
    assert.equal(rCases.filter(row => row.phase === "full").length, 2 * (12 * 8 + 4 * 2));
    const rReport = JSON.parse(fs.readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(rReport.reproducedBaseline, true); assert.deepEqual(rReport.mergeRefused, []);
    assert.deepEqual(rReport.completeness, { complete: true, planned: 210, missing: [], stopped: [], halted: {} });
    assert.deepEqual(rReport.identity[mimo], { baseline: ["xiaomi/mimo-v2.6-pro-preview"], round: ["xiaomi/mimo-v2.6-pro-preview"], unknown: [], unnamed: 0 });
    assert.deepEqual(rReport.merged.models[gemini0], baseReport.models[gemini0], "a model outside the round is judged exactly as in the baseline");
    assert.deepEqual(rReport.verdicts.main, Object.fromEntries(Object.entries(baseReport.verdicts).map(([id, v]) => [id, v.verdict])));
    assert.deepEqual(Object.keys(rReport.verdicts.merged).sort(), Object.keys(baseReport.verdicts).sort());
    assert.deepEqual(rReport.models.after[mimo], rReport.merged.models[mimo]); assert.deepEqual(rReport.models.before[mimo], baseReport.models[mimo]);
    assert.deepEqual(Object.keys(rReport.comparison).sort(), [glm, mimo]);
    assert.equal(rReport.comparison[mimo].after.http, rLedger.models[mimo].attempts.length);
    // Status classes per arm: mimo's two response_format refusals (probe and full profile) stay apart from 2xx.
    assert.deepEqual(rReport.comparison[mimo].after.byArm.probe, { 200: 1, 400: 1 });
    assert.equal(rReport.comparison[mimo].after.statuses[400], 2); assert.equal(rReport.comparison[mimo].after.deadlineMs, ROUND.timeoutMs);
    assert.equal(rReport.comparison[mimo].after.latencyAll.n, rLedger.models[mimo].attempts.length);
    for (const view of ["main", "merged"]) assert.deepEqual(Object.keys(rReport.supplementary.successfulPairs[view]).sort(), ["C5", "C6", "models"]);
    assert.equal(rReport.caveats.length, 4);
    assert.equal(rReport.budget.priorUSD, ledger.spentMicros / 1e6); assert.equal(rReport.budget.cumulativeUSD, (ledger.spentMicros + rLedger.spentMicros) / 1e6);
    assert.equal(rReport.budget.models[mimo].authorizedUSD, 2); assert.equal(rReport.budget.models[mimo].stopUSD, 1.6);
    const rKey = JSON.parse(fs.readFileSync(join(dir, "review-key-usage.json"), "utf8"));
    assert(rKey.length > 0 && rKey.every(row => [glm, mimo].includes(row.model)), "the round's blind sheet holds only the round models' items");
    const rSheet = JSON.parse(fs.readFileSync(join(dir, "review-usage.json"), "utf8"));
    assert(rSheet.every((row, i) => row.id === "rehearsal-U" + String(i + 1).padStart(3, "0") && rKey[i].id === row.id), "round ids carry the round id");
    // No merge from a partial round, a halted one, or one whose model answered under a new name.
    for (const [label, edit, refused] of [
      ["one case missing", l => { delete l.models[mimo].cases["full:" + mimo + ":suibian:A:scenarios"]; }, ["round_incomplete"]],
      ["a model halted", l => { l.models[glm].halted = "cost_limit_model"; }, ["round_incomplete"]],
      ["a new response name", l => { l.models[mimo].attempts.find(a => a.httpStatus === 200).responseModel = "xiaomi/mimo-v2.6-pro-0915"; }, ["model_identity_changed"]]]) {
      const copy = fs.mkdtempSync(join(tmpdir(), "dict-redesign-round-partial-"));
      try {
        for (const name of ["evidence.json", "frozen.json"]) fs.copyFileSync(join(dir, name), join(copy, name));
        const edited = structuredClone(rLedger); edit(edited); fs.writeFileSync(join(copy, "ledger.json"), JSON.stringify(edited));
        const out = await roundReport(roundPlan, copy, testRound);
        assert.deepEqual(out.mergeRefused, refused, label); assert.equal(out.verdicts.merged, null, label);
        assert.equal(fs.existsSync(join(copy, "review-usage.json")), false, label + ": no blind sheet");
        assert.deepEqual(JSON.parse(fs.readFileSync(join(copy, "report.json"), "utf8")).mergeRefused, refused, label);
      } finally { fs.rmSync(copy, { recursive: true, force: true }); }
    }
    assert(rLedger.models[mimo].attempts.every(item => item.state === "settled"));
    // One changed byte of the archived baseline refuses the round report.
    fs.appendFileSync(join(base, "report.json"), " ");
    await assert.rejects(roundReport(roundPlan, dir, testRound), /baseline_changed/);
  } finally { fs.rmSync(roundDir, { recursive: true, force: true }); }
  assert.equal(secretAttempts, 0); assert.equal(configAttempts, 0); assert.equal(networkAttempts, 0);
  write(JSON.stringify({ offlineRehearsal: cases.length + " cases passed", roundRehearsal: roundCases + " cases passed", http: raw.length, secretAttempts, configAttempts, networkAttempts }) + "\n");
} finally { process.stdout.write = write; fs.rmSync(reportDir, { recursive: true, force: true }); }
