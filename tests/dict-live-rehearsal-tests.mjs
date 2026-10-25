// Offline browser integration: fail before any .env probe or Node HTTP call.
// Run separately from the fast guard suite because Chromium needs subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC = `DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
MINIMAX_BASE_URL=https://api.minimax.cn/v1
MINIMAX_MODEL=MiniMax-M3.1-Flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-3.8-flash
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-6.1-sol
`;
let secretAttempts = 0, networkAttempts = 0, output = "", configDir = "";
for (const name of ["readFileSync", "statSync", "existsSync", "openSync"]) {
  const original = fs[name];
  fs[name] = function(path, ...args) {
    if (/(?:^|\/)\.env$/.test(String(path))) { secretAttempts++; throw new Error("FORBIDDEN_SECRET_ACCESS"); }
    if (String(path).endsWith("/providers.env") && String(path) !== join(configDir, "providers.env")) throw new Error("FORBIDDEN_USER_CONFIG_ACCESS");
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch = () => { networkAttempts++; throw new Error("FORBIDDEN_NETWORK"); };
const { main } = await import("../scripts/dict-live-test.mjs");
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = chunk => { output += chunk; return true; };
try {
  configDir = fs.mkdtempSync(join(tmpdir(), "dict-live-rehearsal-config-"));
  fs.writeFileSync(join(configDir, "providers.env"), PUBLIC);
  await main(["--rehearse", "--config-dir", configDir]);
} finally {
  process.stdout.write = write;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
}
const report = JSON.parse(output);
assert.equal(secretAttempts, 0); assert.equal(networkAttempts, 0); assert.equal(report.liveRequests, 0);
assert.equal(report.ok, true);
for (const row of Object.values(report.ledger.providers)) {
  assert.equal(row.attempts.length, 2);
  assert.equal(row.cases.entry.ok, true); assert.equal(row.cases.collocations.ok, true);
}
write(JSON.stringify({ offlineRehearsal: "8/8 passed", secretAttempts, networkAttempts, reportDir: report.reportDir }) + "\n");
