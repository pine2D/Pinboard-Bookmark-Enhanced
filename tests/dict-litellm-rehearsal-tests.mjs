// Execute the real isolated browser harness while forbidding every credential
// file probe and every Node network dispatch. Fixtures own all model answers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

let secretAttempts = 0, networkAttempts = 0;
for (const name of ["readFileSync", "statSync", "existsSync", "openSync"]) {
  const original = fs[name];
  fs[name] = function(path, ...args) {
    if (/(?:^|\/)\.env$/.test(String(path))) { secretAttempts++; throw new Error("FORBIDDEN_SECRET_ACCESS"); }
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch = () => { networkAttempts++; throw new Error("FORBIDDEN_NETWORK"); };
const { main, makePlan, MODELS } = await import("../scripts/dict-litellm-test.mjs");
const reportDir = fs.mkdtempSync(join(tmpdir(), "dict-litellm-rehearsal-"));
const estimates = Object.fromEntries(MODELS.map(model => [model.alias, {
  snapshot: { fetched_at: Math.floor(Date.now() / 1000), stale: false, currency: "USD" },
  result: { status: "estimated", model: model.provider + "/" + model.model, provider: model.provider,
    requests: 12, input_tokens: 25600, output_tokens: 8192, total_usd: "0.08",
    rates_usd_per_million_tokens: { input_cost_per_token: "0.10", output_cost_per_token: "0.20" } }
}]));
fs.writeFileSync(join(reportDir, "plan.json"), JSON.stringify(makePlan(estimates)));
try {
  await main(["--rehearse", "--report-dir", reportDir, "--model", "dashscope/qwen3.8-max", "--reuse-entry-from", "deepseek-flash",
    "--cases", "provider-collocations,provider-confusables,provider-register,provider-grammar,provider-scenarios,provider-literature,based-culture"]);
  const run = fs.readdirSync(reportDir).find(name => name.startsWith("rehearsal-"));
  const ledger = JSON.parse(fs.readFileSync(join(reportDir, run, "ledger.json"), "utf8"));
  const donor = ledger.models["deepseek-flash"], target = ledger.models["dashscope/qwen3.8-max"];
  assert.equal(donor.attempts.length, 2); assert.equal(target.attempts.length, 7);
  assert(Object.values(donor.cases).every(result => result.ok));
  assert(Object.values(target.cases).every(result => result.ok && result.baseEntryModel === "deepseek-flash"));
  assert(!Object.hasOwn(target.cases, "provider-entry"));
  assert.equal(secretAttempts, 0); assert.equal(networkAttempts, 0);
  process.stdout.write(JSON.stringify({ offlineRehearsal: "9/9 passed", secretAttempts, networkAttempts }) + "\n");
} finally { fs.rmSync(reportDir, { recursive: true, force: true }); }
