// Offline browser integration: fail before any .env probe or Node HTTP call.
// Run separately from the fast guard suite because Chromium needs subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

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
const { main } = await import("../scripts/dict-live-test.mjs");
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = chunk => { output += chunk; return true; };
try {
  await main(["--rehearse"]);
} finally { process.stdout.write = write; }
const report = JSON.parse(output);
assert.equal(secretAttempts, 0); assert.equal(networkAttempts, 0); assert.equal(report.liveRequests, 0);
assert.equal(report.ok, true);
for (const row of Object.values(report.ledger.providers)) {
  assert.equal(row.attempts.length, 2);
  assert.equal(row.cases.entry.ok, true); assert.equal(row.cases.collocations.ok, true);
}
write(JSON.stringify({ offlineRehearsal: "8/8 passed", secretAttempts, networkAttempts, reportDir: report.reportDir }) + "\n");
