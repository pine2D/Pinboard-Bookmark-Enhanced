// Contract & runtime tests for the local-only sanitized diagnostic error buffer
// (`pbpDiagErrors` in shared.js + `pbpBuildSanitizedDiagnostics` in options.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function createHarness(initialLocal = {}, opts = {}) {
  const store = structuredClone(initialLocal);
  const local = {
    async get(keys) {
      if (opts.failGet) throw new DOMException("storage read blocked", "InvalidStateError");
      if (keys == null) return structuredClone(store);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = structuredClone(store[k]);
        else if (keys && typeof keys === "object" && !Array.isArray(keys) && k in keys) out[k] = structuredClone(keys[k]);
      }
      return out;
    },
    async set(patch) {
      if (opts.failSet) throw new DOMException("quota full", "QuotaExceededError");
      if (opts.setDelayMs) await new Promise((r) => setTimeout(r, opts.setDelayMs));
      Object.assign(store, structuredClone(patch));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[k];
    },
    async getKeys() {
      return Object.keys(store);
    },
    async getBytesInUse() {
      return JSON.stringify(store).length;
    },
  };
  const ctx = vm.createContext({
    console: { warn() {}, error() {}, info() {}, log() {} },
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    Promise,
    Symbol,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Int32Array,
    setTimeout,
    clearTimeout,
    structuredClone,
    crypto: globalThis.crypto,
    chrome: {
      storage: { local, sync: local, session: local, onChanged: { addListener() {} } },
      runtime: { getManifest: () => ({ version: "3.5" }) },
    },
  });
  vm.runInContext(readFileSync(new URL("../shared.js", import.meta.url), "utf8"), ctx, { filename: "shared.js" });
  const consts = vm.runInContext("({ PBP_DIAG_ERRORS_KEY, PBP_DIAG_ERRORS_CAP, PBP_RECLAIM_CATEGORIES, SETTINGS_DEFAULTS })", ctx);
  return { ctx, store, consts };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test("pbpDiagErrors: fixed 6-key schema strips messages, URLs, credentials, owners, and custom error names", async () => {
  const { ctx, store } = createHarness();
  const recorded = await ctx.pbpRecordDiagError({
    surface: "ai",
    op: "ai_cache",
    code: "idb",
    errorName: "QuotaExceededError",
    status: 503,
    message: "Bearer sk-TOP_SECRET https://secret.example/path alice@private.example",
    stack: "Error: TOP_SECRET\n at secret.example:1:1",
    url: "https://secret.example/article",
    owner: "acct_alice",
    term: "ephemeral",
  });
  assert.ok(recorded);
  assert.deepEqual(Object.keys(recorded), ["ts", "surface", "op", "code", "errorName", "status"]);
  assert.equal(recorded.surface, "ai");
  assert.equal(recorded.op, "ai_cache");
  assert.equal(recorded.code, "idb");
  assert.equal(recorded.errorName, "QuotaExceededError");
  assert.equal(recorded.status, 503);

  await ctx.pbpRecordDiagError({
    surface: "alice",
    op: "TOP_SECRET",
    code: "https://secret.example/token?key=LEAK-ME",
    errorName: "SecretAuthTokenError",
    status: 999,
  });
  await ctx.pbpRecordDiagError({
    surface: "dict",
    op: "acct_alice",
    code: "ephemeral",
    errorName: "alice:EUDIC-SECRET",
    status: "401",
  });

  const rows = plain(await ctx.pbpReadDiagErrors());
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.slice(1).map(({ surface, op, code, errorName, status }) => ({ surface, op, code, errorName, status })),
    [
      { surface: "unknown", op: "unknown", code: "failed", errorName: "Error", status: null },
      { surface: "dict", op: "unknown", code: "failed", errorName: "Error", status: null },
    ],
  );
  const serialized = JSON.stringify({ store, rows });
  for (const forbidden of [
    "TOP_SECRET", "LEAK-ME", "EUDIC-SECRET", "Secret", "alice",
    "secret.example", "private.example", "ephemeral", "Bearer",
  ]) {
    assert.ok(!serialized.includes(forbidden), `leaked forbidden substring: ${forbidden}`);
  }
});

test("pbpDiagErrors: ring buffer caps at 50 newest entries and serializes concurrent writes", async () => {
  const { ctx } = createHarness({}, { setDelayMs: 1 });
  const writes = [];
  for (let i = 0; i < 65; i++) {
    writes.push(ctx.pbpRecordDiagError({
      surface: "popup",
      op: `step_${i}`,
      code: "http",
      errorName: "TypeError",
      status: 500 + (i % 10),
    }));
  }
  const readDuringBurst = ctx.pbpReadDiagErrors();
  await Promise.all(writes);
  const during = await readDuringBurst;
  const finalRows = await ctx.pbpReadDiagErrors();
  assert.equal(during.length, 50);
  assert.equal(finalRows.length, 50);
  assert.equal(finalRows[0].op, "step_15");
  assert.equal(finalRows[49].op, "step_64");
});

test("pbpDiagErrors: tampered storage rows are dropped or stripped and storage failures never throw", async () => {
  const { ctx } = createHarness({
    pbpDiagErrors: [
      null,
      "corrupt",
      { ts: -1, surface: "ai", op: "ai_cache", code: "idb", errorName: "Error", status: null },
      { ts: 1700000000001, surface: "options", op: "sync_migrate", code: "storage", errorName: "DOMException", status: null, extraSecret: "TOP_SECRET" },
      { ts: 1700000000002, surface: "options", op: "auth_token", code: "Secret", errorName: "Error", status: 200 },
      { ts: 1700000000003, surface: "options", op: "wayback_clear", code: "http", errorName: "TimeoutError", status: 504 },
    ],
  });
  const rows = plain(await ctx.pbpReadDiagErrors());
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["ts", "surface", "op", "code", "errorName", "status"]);
  assert.equal("extraSecret" in rows[0], false);
  assert.equal(rows[1].op, "wayback_clear");
  assert.equal(rows[1].status, 504);

  const failing = createHarness({}, { failGet: true, failSet: true });
  assert.equal(await failing.ctx.pbpRecordDiagError({ surface: "ai", op: "ai_cache", code: "idb" }), null);
  assert.deepEqual(plain(await failing.ctx.pbpReadDiagErrors()), []);
  assert.equal(await failing.ctx.pbpRecordDiagError(null), null);
  assert.equal(await failing.ctx.pbpRecordDiagError(new Error("not a plain record")), null);
});

test("pbpDiagErrors: included in misc reclaim bucket, never-clear=false, excluded from SETTINGS_DEFAULTS & backups", async () => {
  const { ctx, store, consts } = createHarness();
  await ctx.pbpRecordDiagError({ surface: "library", op: "vocab_delete", code: "failed", errorName: "Error" });
  assert.equal(consts.PBP_DIAG_ERRORS_KEY, "pbpDiagErrors");
  assert.equal(consts.PBP_DIAG_ERRORS_CAP, 50);
  assert.equal(consts.PBP_RECLAIM_CATEGORIES.misc.keys.includes("pbpDiagErrors"), true);
  assert.equal(ctx.pbpIsNeverClearKey("pbpDiagErrors"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(consts.SETTINGS_DEFAULTS, "pbpDiagErrors"), false);
  assert.ok(Array.isArray(store.pbpDiagErrors) && store.pbpDiagErrors.length === 1);

  const measured = await ctx.pbpMeasureLocalStorage();
  assert.equal(measured.misc.keys.includes("pbpDiagErrors"), true);
  const reclaimed = await ctx.pbpReclaimLocalStorage(["misc"]);
  assert.equal(reclaimed.removed.misc.keys.includes("pbpDiagErrors"), true);
  assert.equal("pbpDiagErrors" in store, false);
});
