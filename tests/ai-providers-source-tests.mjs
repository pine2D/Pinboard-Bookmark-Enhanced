import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PROVIDERS, AI_PROVIDER_CATALOG_IDS, AI_PROVIDER_FALLBACK_IDS } from "../scripts/ai-providers-source.mjs";
import { checkAiProviderSync, findSecondCopyViolations, syncAiProviders } from "../scripts/sync-ai-providers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_FILES = [
  "ai.js",
  "shared.js",
  "popup-ai.js",
  "options.html",
  "options.js",
  "options-connectivity.js",
];

function makeTempWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "pbp-ai-src-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of RUNTIME_FILES) {
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

test("source catalog exports 18 deeply frozen providers with distinct ids and fallback ranks", () => {
  assert.equal(AI_PROVIDERS.length, 18);
  assert.ok(Object.isFrozen(AI_PROVIDERS));
  assert.ok(Object.isFrozen(AI_PROVIDER_CATALOG_IDS));
  assert.ok(Object.isFrozen(AI_PROVIDER_FALLBACK_IDS));
  assert.equal(new Set(AI_PROVIDER_CATALOG_IDS).size, 18);
  assert.equal(new Set(AI_PROVIDER_FALLBACK_IDS).size, 18);
  assert.notDeepEqual(AI_PROVIDER_CATALOG_IDS, AI_PROVIDER_FALLBACK_IDS);
  assert.equal(AI_PROVIDERS[0].id, "gemini");
  assert.ok(Object.isFrozen(AI_PROVIDERS.find((p) => p.id === "qwen").regions));
});

test("live repository passes single-source sync and AST no-second-copy checks", () => {
  const res = checkAiProviderSync(ROOT);
  assert.equal(res.ok, true, res.problems.join("\n"));
  assert.deepEqual(res.drifted, []);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.htmlDrift, []);
  assert.deepEqual(res.astViolations, []);
});

test("drifted defaultModel in shared.js, options.html, or options.js is caught and healed by --write", (t) => {
  const sampleModel = AI_PROVIDERS[0].defaultModel;
  for (const file of ["shared.js", "options.html", "options.js"]) {
    const dir = makeTempWorkspace(t);
    const abs = join(dir, file);
    const original = readFileSync(abs, "utf8");
    const mutated = original.replaceAll(sampleModel, "drifted-model-slug");
    assert.notEqual(mutated, original, `expected ${file} to contain ${sampleModel}`);
    writeFileSync(abs, mutated, "utf8");

    const checkRes = checkAiProviderSync(dir);
    assert.equal(checkRes.ok, false, `drift in ${file} must fail check`);
    assert.ok(checkRes.problems.some((p) => p.includes(file)), `failure must name ${file}: ${checkRes.problems.join("; ")}`);

    const writeRes = syncAiProviders({ root: dir, write: true });
    assert.equal(writeRes.ok, true, `write should restore parity for ${file}`);
    assert.equal(checkAiProviderSync(dir).ok, true, `${file} should pass after sync --write`);
  }
});

test("AST gate rejects hand-written array, object, and hardcoded defaultModel copies outside generated regions", (t) => {
  const cases = [
    {
      name: "array literal",
      code: 'const extraProviders = ["gemini", "openai", "claude", "deepseek", "qwen"];\n',
      rule: "array-second-copy",
    },
    {
      name: "object literal",
      code: 'const extraLabels = { geminiModel: "a", openaiModel: "b", claudeModel: "c", deepseekModel: "d", qwenModel: "e" };\n',
      rule: "object-second-copy",
    },
    {
      name: "hardcoded default model literal",
      code: `const fallback = ${JSON.stringify(AI_PROVIDERS[0].defaultModel)};\n`,
      rule: "hardcoded-default-model",
    },
  ];
  for (const tc of cases) {
    const dir = makeTempWorkspace(t);
    writeFileSync(join(dir, "rogue-copy.js"), tc.code, "utf8");
    const violations = findSecondCopyViolations(dir);
    assert.ok(violations.some((v) => v.file === "rogue-copy.js" && v.line === 1 && v.rule === tc.rule),
      `expected ${tc.name} violation (${tc.rule}), got: ${JSON.stringify(violations)}`);
    const syncRes = checkAiProviderSync(dir);
    assert.equal(syncRes.ok, false);
    assert.ok(syncRes.problems.some((p) => p.includes("rogue-copy.js:1")));
  }
});
