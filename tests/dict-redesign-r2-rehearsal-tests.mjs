// Offline checks of the revised comparison driver's entry points: --plan and
// refused --live paths never probe .env or the network, and --rehearse drives
// the redesigned reader UI (AI entry button, the "usage points" block's two
// paid buttons and the etymology button) with handwritten responses through
// the production prompts, parsers, archive and rendering. Run separately from
// the fast guard suite because Chromium needs subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

let secretAttempts = 0, networkAttempts = 0, output = "";
for (const name of ["readFileSync", "statSync", "existsSync", "openSync"]) {
  const original = fs[name];
  fs[name] = function(path, ...args) {
    if (/(?:^|\/)\.env$/.test(String(path))) { secretAttempts++; throw new Error("FORBIDDEN_SECRET_ACCESS"); }
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch = () => { networkAttempts++; throw new Error("FORBIDDEN_NETWORK"); };
const { main, PRODUCT_FINGERPRINT } = await import("../scripts/dict-redesign-test-r2.mjs");
const write = process.stdout.write.bind(process.stdout);
const capture = async (args, inject) => {
  output = "";
  process.stdout.write = chunk => { output += chunk; return true; };
  try { await main(args, inject); return { output }; }
  catch (error) { return { output, error: error?.safeCode || error?.message }; }
  finally { process.stdout.write = write; }
};
const pinned = () => ({ product: PRODUCT_FINGERPRINT, driver: "d".repeat(64) });
const dir = fs.mkdtempSync(join(tmpdir(), "dict-r2-rehearsal-config-"));
let results = 0;
try {
  const config = join(dir, "run.json"), approval = join(dir, "approval.json");
  fs.writeFileSync(config, JSON.stringify({ schema: 1, endpoint: "https://gateway.example.test/v1", keyVariable: "GATEWAY_API_KEY", currency: "USD",
    totalCap: 1, words: ["charge"], models: [{ id: "vendor/model-one", cap: 1, inputPerMillion: 1, outputPerMillion: 4, priceSource: "ai-dev prices", priceVerifiedAt: "2026-10-27" }] }));
  const plan = await capture(["--plan", "--config", config], { fingerprints: pinned });
  assert.equal(plan.error, undefined);
  const planned = JSON.parse(plan.output);
  assert.equal(planned.approvalTemplate.authorized, false); assert.equal(planned.cases, 4);
  assert.deepEqual(planned.plan.arms, ["entry", "patterns", "confusables", "etymology"]);
  results++;
  // Another product (a later batch) refuses the plan before any approval exists.
  assert.equal((await capture(["--plan", "--config", config], { fingerprints: () => ({ product: "0".repeat(64), driver: "d".repeat(64) }) })).error, "product_changed");
  results++;
  const day = Date.parse("2026-10-27T12:00:00Z");
  fs.writeFileSync(approval, JSON.stringify({ ...planned.approvalTemplate, authorizationReference: "synthetic" }));
  assert.equal((await capture(["--live", "--config", config, "--approval", approval], { fingerprints: pinned, now: day })).error, "approval_required_or_mismatched");
  assert.equal((await capture(["--live", "--config", config], { fingerprints: pinned, now: day })).error, "approval_required_or_mismatched");
  results++;
  fs.writeFileSync(approval, JSON.stringify({ ...planned.approvalTemplate, authorized: true, authorizationReference: "synthetic" }));
  assert.equal((await capture(["--live", "--config", config, "--approval", approval], { fingerprints: pinned, now: Date.parse("2026-10-28T00:00:00Z") })).error,
    "price_verification_expired");
  assert.equal((await capture(["--live", "--config", config, "--approval", approval], { fingerprints: () => ({ product: "0".repeat(64), driver: "d".repeat(64) }), now: day })).error,
    "product_changed");
  results++;
  assert.equal((await capture(["--rehearse", "--live"])).error, "conflicting_modes");
  results++;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const rehearsal = await capture(["--rehearse"]);
assert.equal(rehearsal.error, undefined, rehearsal.error);
const report = JSON.parse(rehearsal.output.slice(rehearsal.output.indexOf("{\n")));
assert.equal(report.liveRequests, 0); assert.equal(report.ok, true);
const row = report.ledger.models["rehearsal/model-a"];
// One HTTP request per click, in the fixed order of the redesigned blocks.
assert.deepEqual(row.attempts.map(item => item.caseId.split(":").at(-1)), ["entry", "patterns", "confusables", "etymology"]);
assert.ok(row.attempts.every(item => item.httpStatus === 200 && item.state === "received"));
for (const arm of ["entry", "patterns", "confusables", "etymology"]) {
  const item = row.cases["rehearsal/model-a:charge:" + arm];
  assert.equal(item.outcome, "success", arm); assert.ok(item.keptItems > 0, arm); assert.equal(item.omittedItems, 0, arm);
  // Every supplement button reports "saved" in its own feedback line.
  if (arm !== "entry") assert.equal(item.feedback, "saved", arm);
  results++;
}
// Only the etymology click reads Wiktionary; the missing page leaves it
// without sources, so the formation-only answer is the one that was saved.
assert.equal(row.cases["rehearsal/model-a:charge:etymology"].wikimediaRequests, 1);
assert.equal(row.cases["rehearsal/model-a:charge:patterns"].wikimediaRequests, 0);
const etymology = JSON.parse(fs.readFileSync(join(report.outDir, "content", "rehearsal_model-a_charge_etymology.json"), "utf8"));
assert.deepEqual(etymology.content.learning.items.map(item => item.kind), ["formation"]);
assert.deepEqual(etymology.content.sources, []);
results++;
// A click the product refuses before its run function is a harness result,
// recorded at once instead of waiting out the per-case timeout: the
// Wiktionary grant is denied (etymology shows its own error line) and the
// confusables click is swallowed (no busy state, as a guard that returns).
const refusedRun = await capture(["--rehearse"], { rehearsal: { deny: ["https://en.wiktionary.org"], swallow: ["confusables"] } });
process.exitCode = 0;
assert.equal(refusedRun.error, undefined, refusedRun.error);
const refused = JSON.parse(refusedRun.output.slice(refusedRun.output.indexOf("{\n")));
assert.equal(refused.liveRequests, 0); assert.equal(refused.ok, false);
const refusedRow = refused.ledger.models["rehearsal/model-a"], refusedCase = arm => refusedRow.cases["rehearsal/model-a:charge:" + arm];
assert.deepEqual(refusedRow.attempts.map(item => item.caseId.split(":").at(-1)), ["entry", "patterns"]);
assert.equal(refusedCase("entry").outcome, "success"); assert.equal(refusedCase("patterns").outcome, "success");
assert.deepEqual([refusedCase("confusables").outcome, refusedCase("confusables").code], ["harness", "click_ignored"]);
assert.deepEqual([refusedCase("etymology").outcome, refusedCase("etymology").code, refusedCase("etymology").feedback], ["harness", "click_rejected", "error"]);
assert.equal(refusedCase("etymology").wikimediaRequests, 0);
for (const arm of ["confusables", "etymology"]) assert.ok(refusedCase(arm).wallMs < 30000, arm + " waited " + refusedCase(arm).wallMs + " ms");
results++;
assert.equal(secretAttempts, 0); assert.equal(networkAttempts, 0);
write(JSON.stringify({ offlineRehearsal: results + "/" + results + " passed", secretAttempts, networkAttempts, outDir: report.outDir }) + "\n");
