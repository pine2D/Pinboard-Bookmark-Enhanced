// Contract & runtime tests for the local-only sanitized diagnostic error buffer
// (`pbpDiagErrors` in shared.js + surface attribution in jina.js + callback error
// safety in ai.js / dict-pack.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SHARED_SRC = readFileSync(new URL("../shared.js", import.meta.url), "utf8");
const JINA_SRC = readFileSync(new URL("../jina.js", import.meta.url), "utf8");
const AI_SRC = readFileSync(new URL("../ai.js", import.meta.url), "utf8");

function createOriginCoordinator() {
  const queues = new Map();
  return {
    request(name, optionsOrCallback, maybeCallback) {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const prev = queues.get(name) || Promise.resolve();
      const run = prev.then(() => cb({ name, mode: "exclusive" }));
      queues.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function createOriginHarness(initialLocal = {}, opts = {}) {
  const store = structuredClone(initialLocal);
  const listeners = new Set();
  const locks = opts.noWebLocks ? undefined : createOriginCoordinator();

  function makePageContext(pageOpts = {}) {
    const warns = [];
    const local = {
      async get(keys) {
        if (pageOpts.failGet || opts.failGet) {
          throw new DOMException("storage read blocked", "InvalidStateError");
        }
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
        if (pageOpts.beforeSet) await pageOpts.beforeSet(patch);
        if (pageOpts.failSet || opts.failSet) {
          throw new DOMException("quota full", "QuotaExceededError");
        }
        if (opts.setDelayMs) await new Promise((r) => setTimeout(r, opts.setDelayMs));
        const changes = {};
        for (const [k, v] of Object.entries(patch)) {
          const oldVal = Object.prototype.hasOwnProperty.call(store, k) ? structuredClone(store[k]) : undefined;
          const newVal = structuredClone(v);
          store[k] = newVal;
          changes[k] = { oldValue: oldVal, newValue: structuredClone(v) };
        }
        for (const fn of listeners) fn(structuredClone(changes), "local");
        if (pageOpts.afterSet) await pageOpts.afterSet(patch);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (Object.prototype.hasOwnProperty.call(store, k)) {
            const oldVal = structuredClone(store[k]);
            delete store[k];
            changes[k] = { oldValue: oldVal, newValue: undefined };
          }
        }
        if (Object.keys(changes).length) {
          for (const fn of listeners) fn(structuredClone(changes), "local");
        }
      },
      async getKeys() {
        return Object.keys(store);
      },
      async getBytesInUse() {
        return JSON.stringify(store).length;
      },
    };

    const nav = locks ? { locks } : {};
    const sandbox = {
      console: {
        warn(...args) { warns.push(args); },
        error() {},
        info() {},
        log() {},
      },
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
      Proxy,
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
      navigator: nav,
      chrome: {
        storage: {
          local,
          sync: local,
          session: local,
          onChanged: {
            addListener(fn) { listeners.add(fn); },
          },
        },
        permissions: {
          async contains() { return true; },
        },
        runtime: { id: "ext-test-id", getManifest: () => ({ version: "3.5" }) },
      },
    };
    if (pageOpts.pathname) {
      sandbox.document = { getElementById: () => null };
      sandbox.location = { pathname: pageOpts.pathname };
    }
    if (pageOpts.fetchWithTimeout) {
      sandbox.fetchWithTimeout = pageOpts.fetchWithTimeout;
    }
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SHARED_SRC, ctx, { filename: "shared.js" });
    if (pageOpts.loadJina) vm.runInContext(JINA_SRC, ctx, { filename: "jina.js" });
    if (pageOpts.loadAi) vm.runInContext(AI_SRC, ctx, { filename: "ai.js" });
    const consts = vm.runInContext(
      "({ PBP_DIAG_ERRORS_KEY, PBP_DIAG_ERRORS_CAP, PBP_DIAG_OPS, PBP_DIAG_CODES, PBP_DIAG_SURFACES, PBP_DIAG_ERROR_NAMES, PBP_RECLAIM_CATEGORIES, SETTINGS_DEFAULTS })",
      ctx,
    );
    return { ctx, local, warns, consts };
  }

  const primary = makePageContext(opts.pageOpts || {});
  return { ...primary, store, makePageContext };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test("pbpDiagErrors: closed allowlists reject unregistered snake_case strings, messages, URLs, credentials, owners, and custom error names", async () => {
  const { ctx, store } = createOriginHarness({
    pbpDiagErrors: [
      {
        ts: 1700000000010,
        surface: "options",
        op: "green_meadow",
        code: "silver_maple",
        errorName: "Error",
        status: null,
        message: "extra field",
      },
    ],
  });
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
    op: "blue_orchid",
    code: "silver_maple",
    errorName: "blue_orchid",
    status: 999,
  });
  await ctx.pbpRecordDiagError({
    surface: "dict",
    op: "acct_alice",
    code: "https://secret.example/token?key=LEAK-ME",
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
    "blue_orchid", "silver_maple", "green_meadow",
    "TOP_SECRET", "LEAK-ME", "EUDIC-SECRET", "Secret", "alice",
    "secret.example", "private.example", "ephemeral", "Bearer",
  ]) {
    assert.ok(!serialized.includes(forbidden), `leaked forbidden substring: ${forbidden}`);
  }
});

test("pbpDiagErrors: ring buffer caps at 50 newest entries using registered ops and status markers", async () => {
  const { ctx, consts } = createOriginHarness({}, { setDelayMs: 1 });
  const registeredOps = plain(consts.PBP_DIAG_OPS).filter((op) => op !== "unknown");
  assert.ok(registeredOps.length >= 20);
  const writes = [];
  for (let i = 0; i < 65; i++) {
    writes.push(ctx.pbpRecordDiagError({
      surface: "popup",
      op: registeredOps[i % registeredOps.length],
      code: "http",
      errorName: "TypeError",
      status: 200 + i,
    }));
  }
  const readDuringBurst = ctx.pbpReadDiagErrors();
  await Promise.all(writes);
  const during = plain(await readDuringBurst);
  const finalRows = plain(await ctx.pbpReadDiagErrors());
  assert.equal(during.length, 50);
  assert.equal(finalRows.length, 50);
  assert.equal(finalRows[0].status, 215);
  assert.equal(finalRows[49].status, 264);
  assert.equal(finalRows[0].op, registeredOps[15 % registeredOps.length]);
  assert.equal(finalRows[49].op, registeredOps[64 % registeredOps.length]);
});

test("pbpDiagErrors: two independent extension pages concurrently writing never lose updates across 12 rounds", async () => {
  const origin = createOriginHarness();
  const pageA = origin.makePageContext({ pathname: "/popup.html" });
  const pageB = origin.makePageContext({ pathname: "/options.html" });

  for (let round = 0; round < 12; round++) {
    await pageB.ctx.pbpReclaimLocalStorage(["misc"]);
    const [resA, resB] = await Promise.all([
      pageA.ctx.pbpRecordDiagError({
        surface: "popup",
        op: "bookmark_delete",
        code: "network",
        errorName: "TypeError",
        status: 502,
      }),
      pageB.ctx.pbpRecordDiagError({
        surface: "options",
        op: "storage_measure",
        code: "storage",
        errorName: "InvalidStateError",
      }),
    ]);
    assert.ok(resA && resB, `round ${round}: both writers must resolve to entries`);
    const stored = plain(await pageA.ctx.pbpReadDiagErrors());
    assert.equal(stored.length, 2, `round ${round}: lost concurrent update (${JSON.stringify(stored)})`);
    assert.deepEqual(
      stored.map((r) => r.op).sort(),
      ["bookmark_delete", "storage_measure"],
    );
  }
});

test("pbpDiagErrors: pbpReclaimLocalStorage(['misc']) during an in-flight append never resurrects cleared history", async () => {
  const origin = createOriginHarness();
  let releaseGate;
  let notifyPaused;
  const pausedAtSet = new Promise((r) => { notifyPaused = r; });
  const setGate = new Promise((r) => { releaseGate = r; });
  let armed = false;

  const pageA = origin.makePageContext({
    pathname: "/popup.html",
    async beforeSet() {
      if (armed) {
        armed = false;
        notifyPaused();
        await setGate;
      }
    },
  });
  const pageB = origin.makePageContext({ pathname: "/options.html" });

  await pageA.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "bookmark_delete",
    code: "network",
    errorName: "TypeError",
  });
  assert.equal((await pageB.ctx.pbpReadDiagErrors()).length, 1);

  armed = true;
  const pendingAppend = pageA.ctx.pbpRecordDiagError({
    surface: "options",
    op: "storage_measure",
    code: "storage",
    errorName: "InvalidStateError",
  });
  await pausedAtSet;

  const reclaimed = plain(await pageB.ctx.pbpReclaimLocalStorage(["misc"]));
  assert.equal(reclaimed.removed.misc.keys.includes("pbpDiagErrors"), true);
  assert.equal("pbpDiagErrors" in origin.store, false);

  releaseGate();
  await pendingAppend;

  const afterRows = plain(await pageB.ctx.pbpReadDiagErrors());
  assert.equal(afterRows.some((r) => r.op === "bookmark_delete"), false, "cleared bookmark_delete history must never reappear");
  assert.deepEqual(afterRows.map((r) => r.op), ["storage_measure"]);

  // Second interleaving: reclaim runs AFTER underlying set wrote, while set's post-return is still pending -> stays empty.
  let releaseAfterSet;
  let notifyAfterSet;
  const reachedAfterSet = new Promise((r) => { notifyAfterSet = r; });
  const afterSetGate = new Promise((r) => { releaseAfterSet = r; });
  let armAfter = true;
  const pageC = origin.makePageContext({
    pathname: "/library.html",
    async afterSet() {
      if (armAfter) {
        armAfter = false;
        notifyAfterSet();
        await afterSetGate;
      }
    },
  });
  const pendingC = pageC.ctx.pbpRecordDiagError({
    surface: "library",
    op: "vocab_delete",
    code: "failed",
    errorName: "Error",
  });
  await reachedAfterSet;
  await pageB.ctx.pbpReclaimLocalStorage(["misc"]);
  releaseAfterSet();
  await pendingC;
  assert.equal("pbpDiagErrors" in origin.store, false);
  assert.deepEqual(plain(await pageB.ctx.pbpReadDiagErrors()), []);
});

test("pbpDiagErrors: hostile getters, proxies, tampered rows, and throwing callback error names never throw or leak", async () => {
  const { ctx, makePageContext } = createOriginHarness({
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

  // Accessor property that changes across reads or throws synchronously:
  let statusReads = 599;
  const mutatingInput = {
    surface: "popup",
    op: "bookmark_delete",
    code: "http",
    errorName: "Error",
    get status() {
      statusReads += 1;
      return statusReads;
    },
  };
  const fromGetter = plain(await ctx.pbpRecordDiagError(mutatingInput));
  assert.equal(fromGetter.status, null, "getter property must not be invoked or stored as out-of-range status");
  const readBack = plain(await ctx.pbpReadDiagErrors());
  assert.equal(readBack[readBack.length - 1].op, "bookmark_delete");
  assert.equal(readBack[readBack.length - 1].status, null);

  const throwingGetter = {
    surface: "popup",
    get op() { throw new Error("getter exploded"); },
  };
  // Must NOT throw synchronously and must still record fallback "unknown" safely
  const fromThrowingProp = plain(await ctx.pbpRecordDiagError(throwingGetter));
  assert.equal(fromThrowingProp.op, "unknown");

  const hostileProxy = new Proxy({}, {
    getPrototypeOf() { throw new Error("proxy trap exploded"); },
  });
  assert.equal(await ctx.pbpRecordDiagError(hostileProxy), null);

  // pbpSafeErrorName + _pbpUsageSink callback error-name hardening:
  assert.equal(ctx.pbpSafeErrorName(Object.assign(new Error("msg"), { name: "blue_orchid" })), "Error");
  assert.equal(ctx.pbpSafeErrorName({ get name() { throw new Error("boom"); } }), "Error");
  assert.equal(ctx.pbpSafeErrorName(new DOMException("x", "QuotaExceededError")), "QuotaExceededError");

  const aiPage = makePageContext({ loadAi: true });
  const sinkCustom = vm.runInContext(
    `(() => {
      const s = _pbpUsageSink((o) => o, {
        onUsage() {
          const e = new Error("secret");
          e.name = "blue_orchid";
          throw e;
        }
      });
      s.onRaw({ inTok: 3, outTok: 5 });
      s.flush();
      return true;
    })()`,
    aiPage.ctx,
  );
  assert.equal(sinkCustom, true);
  assert.equal(JSON.stringify(aiPage.warns).includes("blue_orchid"), false);

  const sinkThrowingName = vm.runInContext(
    `(() => {
      const s = _pbpUsageSink((o) => o, {
        onUsage() {
          throw { get name() { throw new Error("getter boom"); } };
        }
      });
      s.onRaw({ inTok: 1, outTok: 2 });
      s.flush();
      return true;
    })()`,
    aiPage.ctx,
  );
  assert.equal(sinkThrowingName, true);
});

test("pbpDiagErrors: Jina cache surface attribution and pbpMeasureLocalStorage failure reporting", async () => {
  const origin = createOriginHarness();
  let failNextRead = false;
  const popupPage = origin.makePageContext({
    pathname: "/popup.html",
    loadJina: true,
    async fetchWithTimeout() {
      return {
        ok: true,
        status: 200,
        async json() { return { data: { content: "# Hello", title: "T" } }; },
      };
    },
  });
  const origPopupGet = popupPage.local.get;
  popupPage.local.get = async (keys) => {
    if (failNextRead && typeof keys === "string" && keys.startsWith("jina_md_")) {
      failNextRead = false;
      throw new DOMException("cache read failed", "InvalidStateError");
    }
    return origPopupGet(keys);
  };

  failNextRead = true;
  const jinaRes = plain(await popupPage.ctx.fetchJinaMarkdown("https://example.com/a", { cacheDuration: 0 }));
  assert.equal(jinaRes.markdown, "# Hello");
  let rows = plain(await popupPage.ctx.pbpReadDiagErrors());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, "popup");
  assert.equal(rows[0].op, "jina_cache_read");

  // pbpMeasureLocalStorage when get(null) throws: marks failed: true and records storage_measure
  const optPage = origin.makePageContext({ pathname: "/options.html" });
  const origOptGet = optPage.local.get;
  optPage.local.get = async (keys) => {
    if (keys === null) throw new DOMException("read null failed", "NotReadableError");
    return origOptGet(keys);
  };
  const measured = plain(await optPage.ctx.pbpMeasureLocalStorage());
  assert.equal(measured.misc.failed, true);
  assert.equal(measured.jina.failed, true);
  assert.deepEqual(measured.misc.keys, []);
  rows = plain(await popupPage.ctx.pbpReadDiagErrors());
  assert.equal(rows.length, 2);
  assert.equal(rows[1].surface, "options");
  assert.equal(rows[1].op, "storage_measure");
  assert.equal(rows[1].code, "storage");
  assert.equal(rows[1].errorName, "NotReadableError");
});
