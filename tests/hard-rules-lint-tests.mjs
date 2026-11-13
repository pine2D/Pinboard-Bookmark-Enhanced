// Self-tests for scripts/commit-msg-lint.mjs, scripts/commit-msg-hook.sh,
// and scripts/hard-rules-lint.mjs (roadmap §7.2 mechanical gates).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALLOWED_COMMIT_TYPES, cleanCommitLines, validateCommitMessage } from "../scripts/commit-msg-lint.mjs";
import { checkSyncWriteErrorHandling, checkCredentialLiterals, runHardRulesLint, DEFAULT_ROOT } from "../scripts/hard-rules-lint.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("live repository passes sync-write error gate and credential literal scan with zero errors", () => {
  const res = runHardRulesLint(DEFAULT_ROOT);
  assert.deepEqual(res.errors, []);
  assert.ok(res.checkedCalls >= 15, `expected >= 15 sync storage write calls, got ${res.checkedCalls}`);
  assert.ok(res.scannedFiles >= 100, `expected >= 100 scanned files, got ${res.scannedFiles}`);
});

test("commit-msg validator accepts all repository Conventional Commit forms and git merge/revert subjects", () => {
  for (const type of ALLOWED_COMMIT_TYPES) {
    assert.equal(validateCommitMessage(`${type}: concise summary`).ok, true, type);
    assert.equal(validateCommitMessage(`${type}(reader-ui): scoped summary`).ok, true, `${type}(scope)`);
  }
  assert.equal(validateCommitMessage("refactor(store)!: breaking change\n\nBody paragraph.").ok, true);
  assert.equal(validateCommitMessage('Revert "fix(popup): restore old behavior"').ok, true);
  assert.equal(validateCommitMessage("Merge pull request #15 from pine2D/refactor/settings-schema").ok, true);
  assert.equal(
    validateCommitMessage(
      "fix(sync): handle quota rejection\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\nnot a valid line if not stripped"
    ).ok,
    true
  );
  assert.deepEqual(
    cleanCommitLines("\n# comment\nfeat: subject\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x"),
    ["feat: subject"]
  );
});

test("commit-msg validator and commit-msg-hook.sh reject empty, malformed, and missing-blank-line messages", () => {
  assert.equal(validateCommitMessage("").ok, false);
  assert.equal(validateCommitMessage("# only comments\n# nothing else\n").ok, false);
  assert.equal(validateCommitMessage("wip save progress").ok, false);
  assert.equal(validateCommitMessage("feat:missing space").ok, false);
  assert.equal(validateCommitMessage("unknown(scope): bad type").ok, false);
  assert.equal(validateCommitMessage("fix: trailing space ").ok, false);
  assert.equal(validateCommitMessage("fix: subject\nbody without blank line").ok, false);

  const dir = mkdtempSync(join(tmpdir(), "pbp-commit-msg-"));
  try {
    const goodFile = join(dir, "GOOD_EDITMSG");
    const badFile = join(dir, "BAD_EDITMSG");
    writeFileSync(goodFile, "chore(hooks): validate commit message format\n");
    writeFileSync(badFile, "update stuff\n");

    const goodRun = spawnSync("sh", [join(ROOT, "scripts/commit-msg-hook.sh"), goodFile], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(goodRun.status, 0, goodRun.stderr);

    const badRun = spawnSync("sh", [join(ROOT, "scripts/commit-msg-hook.sh"), badFile], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /COMMIT BLOCKED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-write error gate rejects callbacks missing lastError, floating Promises, and unguarded listener writes", () => {
  const bad = checkSyncWriteErrorHandling({
    files: {
      "sample.js": [
        "function badCallback() {",
        "  chrome.storage.sync.set({ a: 1 }, () => { console.log('saved'); });",
        "}",
        "function goodCallback() {",
        "  chrome.storage.sync.set({ a: 1 }, () => { if (chrome.runtime.lastError) return; });",
        "}",
        "function floatingDirect() {",
        "  chrome.storage.sync.set({ a: 1 });",
        "}",
        "async function floatingAlias(flag) {",
        "  const area = flag ? chrome.storage.sync : chrome.storage.local;",
        "  area.remove('k');",
        "}",
        "chrome.runtime.onInstalled.addListener(async () => {",
        "  await chrome.storage.sync.set({ b: 2 });",
        "});",
        "chrome.runtime.onStartup.addListener(async () => {",
        "  try { await chrome.storage.sync.set({ b: 2 }); } catch (e) { console.warn(e); }",
        "});",
        "function unrelatedSameName() {",
        "  const area = new Map();",
        "  area.set('k', 1);",
        "}",
      ].join("\n"),
    },
  });
  assert.equal(bad.checkedCalls, 6);
  assert.equal(bad.errors.length, 4, bad.errors.join("\n"));
  assert.match(bad.errors[0], /sample\.js:2:.*lastError/);
  assert.match(bad.errors[1], /sample\.js:8:.*unawaited/);
  assert.match(bad.errors[2], /sample\.js:12:.*unawaited/);
  assert.match(bad.errors[3], /sample\.js:15:.*event listener/);
});

test("credential literal scan rejects hardcoded API_KEY_FIELDS defaults and leaked tokens while allowing synthetic test dummies", () => {
  // Build sample tokens dynamically so this file contains no literal credential substrings.
  const fakeOpenAi = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
  const fakeGoogle = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
  const fakeGithub = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const fakeNotion = "ntn_" + "1234567890abcdef1234567890abcdef12";
  const fakeWebhook = "https://hooks.slack" + ".com/services/T12345678/B12345678/abcdefghijklmnop1234";
  const fakePem = "-----BEGIN " + "RSA PRIVATE KEY-----";

  const res = checkCredentialLiterals({
    apiKeyFields: ["openaiApiKey", "pinboardToken"],
    runtimeFiles: {
      "good.js": "const DEFAULTS = { openaiApiKey: '', pinboardToken: '', exportTargets: { obsidian: { vault: 'Notes' } } };",
      "bad.js": [
        "const DEFAULTS = { openaiApiKey: 'hardcoded-secret', exportTargets: { webhook: { url: 'https://example.com/hook' } } };",
        "window.cfg = {}; window.cfg.pinboardToken = 'alice:deadbeef';",
      ].join("\n"),
    },
    trackedFiles: {
      "tests/fixture.html": "const dummy = 'sk-tester-fixture-000'; const pb = 'alice:token';",
      "leaked.txt": [fakeOpenAi, fakeGoogle, fakeGithub, fakeNotion, fakeWebhook, fakePem].join("\n"),
    },
  });

  assert.equal(res.errors.length, 9, res.errors.join("\n"));
  assert.match(res.errors[0], /bad\.js:1:.*openaiApiKey/);
  assert.match(res.errors[1], /bad\.js:1:.*exportTargets\.webhook\.url/);
  assert.match(res.errors[2], /bad\.js:2:.*pinboardToken/);
  assert.match(res.errors[3], /leaked\.txt:1:.*openai-or-anthropic-prefixed-key/);
  assert.match(res.errors[4], /leaked\.txt:2:.*google-api-key/);
  assert.match(res.errors[5], /leaked\.txt:3:.*github-pat/);
  assert.match(res.errors[6], /leaked\.txt:4:.*notion-secret/);
  assert.match(res.errors[7], /leaked\.txt:5:.*slack-webhook-url/);
  assert.match(res.errors[8], /leaked\.txt:6:.*private-key-pem/);
});
