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

// Models the browser's origin-wide Web Locks manager, including automatic lock
// release when a client context closes/terminates mid-callback.
function createOriginCoordinator() {
  const queues = new Map();
  return {
    createClientLocks() {
      const clientAbort = new Set();
      return {
        closeClient() {
          for (const release of clientAbort) release();
          clientAbort.clear();
        },
        locks: {
          request(name, optionsOrCallback, maybeCallback) {
            const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
            const prev = queues.get(name) || Promise.resolve();
            let releaseEarly;
            const earlyPromise = new Promise((r) => { releaseEarly = r; });
            clientAbort.add(releaseEarly);
            let resultPromise;
            const holder = prev.then(async () => {
              resultPromise = Promise.resolve().then(() => cb({ name, mode: "exclusive" }));
              await Promise.race([
                resultPromise.catch(() => {}),
                earlyPromise,
              ]);
            });
            queues.set(name, holder.catch(() => {}));
            return prev.then(() => resultPromise).finally(() => {
              clientAbort.delete(releaseEarly);
            });
          },
        },
      };
    },
  };
}

function createOriginHarness(initialLocal = {}, opts = {}) {
  const store = structuredClone(initialLocal);
  const listeners = new Set();
  const coordinator = opts.noWebLocks ? null : createOriginCoordinator();

  function makePageContext(pageOpts = {}) {
    const warns = [];
    let closed = false;
    const state = {
      failGet: !!pageOpts.failGet,
      failSet: !!pageOpts.failSet,
      enumCalls: 0,
    };
    const local = {
      async get(keys) {
        if (closed) throw new DOMException("context closed", "InvalidStateError");
        if (state.failGet || opts.failGet) {
          throw new DOMException("storage read blocked", "InvalidStateError");
        }
        if (keys == null) {
          state.enumCalls += 1;
          return structuredClone(store);
        }
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
        if (closed) throw new DOMException("context closed", "InvalidStateError");
        if (state.failSet || opts.failSet) {
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
        if (closed) return new Promise(() => {});
      },
      async remove(keys) {
        if (closed) throw new DOMException("context closed", "InvalidStateError");
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
        if (closed) throw new DOMException("context closed", "InvalidStateError");
        if (state.failGet || opts.failGet) {
          throw new DOMException("storage getKeys blocked", "InvalidStateError");
        }
        state.enumCalls += 1;
        return Object.keys(store);
      },
      async getBytesInUse() {
        return JSON.stringify(store).length;
      },
    };

    const clientLockHandle = coordinator && !pageOpts.throwingLocksGetter
      ? coordinator.createClientLocks()
      : null;
    const nav = {};
    if (pageOpts.throwingLocksGetter) {
      Object.defineProperty(nav, "locks", {
        get() { throw new DOMException("Access to Locks API denied", "SecurityError"); },
      });
    } else if (clientLockHandle) {
      nav.locks = clientLockHandle.locks;
    }

    const onChangedListener = (changes, area) => {
      if (!closed && listenerRef) listenerRef(changes, area);
    };
    let listenerRef = null;

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
            addListener(fn) {
              listenerRef = fn;
              listeners.add(onChangedListener);
            },
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
    return {
      ctx,
      local,
      state,
      warns,
      consts,
      closePage() {
        closed = true;
        listeners.delete(onChangedListener);
        if (clientLockHandle) clientLockHandle.closeClient();
      },
    };
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

test("pbpDiagErrors: shared Web Lock serializes reclaim with writer close, double clears, and post-clear writes", async () => {
  const origin = createOriginHarness();

  // Case 0 (mutation-proof lock-order check): Popup A reads H (211) and pauses in beforeSet
  // before committing N (212). Settings B starts pbpReclaimLocalStorage(["misc"]) while A holds
  // the lock: B MUST block on the lock with 0 storage enumerations until A releases (removing
  // the lock or narrowing it to local.remove fails both enumCalls===0 and the empty-disk check).
  let notifyPausedBeforeSet;
  let releaseBeforeSet;
  const pausedBeforeSet = new Promise((r) => { notifyPausedBeforeSet = r; });
  const beforeSetGate = new Promise((r) => { releaseBeforeSet = r; });
  let holdBeforeSet = false;

  // Case 1: Popup A reads H, writes [H, N] to storage, and closes right as its write lands
  // while Settings B's pbpReclaimLocalStorage(["misc"]) is queued on the lock -> B sweeps [H, N].
  let notifyWrote;
  const wroteToDisk = new Promise((r) => { notifyWrote = r; });
  let closeOnWrite = false;
  let popupA;
  popupA = origin.makePageContext({
    pathname: "/popup.html",
    async beforeSet() {
      if (holdBeforeSet) {
        holdBeforeSet = false;
        notifyPausedBeforeSet();
        await beforeSetGate;
      }
    },
    async afterSet() {
      if (closeOnWrite) {
        closeOnWrite = false;
        popupA.closePage();
        notifyWrote();
      }
    },
  });
  const optionsB = origin.makePageContext({ pathname: "/options.html" });
  const pageC = origin.makePageContext({ pathname: "/library.html" });

  await popupA.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "bookmark_delete",
    code: "network",
    errorName: "TypeError",
    status: 211,
  });
  assert.equal((await optionsB.ctx.pbpReadDiagErrors()).length, 1);

  holdBeforeSet = true;
  const inflightAppend0 = popupA.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "obsidian_clip",
    code: "denied",
    errorName: "NotAllowedError",
    status: 212,
  });
  await pausedBeforeSet;

  optionsB.state.enumCalls = 0;
  const queuedReclaim0 = optionsB.ctx.pbpReclaimLocalStorage(["misc"]);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(
    optionsB.state.enumCalls,
    0,
    "reclaim(['misc']) must wait on pbp-diag-errors Web Lock before enumerating storage",
  );
  releaseBeforeSet();
  await inflightAppend0;
  const reclaimed0 = plain(await queuedReclaim0);
  assert.equal(reclaimed0.removed.misc.keys.includes("pbpDiagErrors"), true);
  assert.equal("pbpDiagErrors" in origin.store, false);
  assert.deepEqual(plain(await optionsB.ctx.pbpReadDiagErrors()), []);

  // Re-seed H and verify writer closing right after its write lands while reclaim is queued:
  await popupA.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "bookmark_delete",
    code: "network",
    errorName: "TypeError",
  });
  assert.equal((await optionsB.ctx.pbpReadDiagErrors()).length, 1);

  closeOnWrite = true;
  void popupA.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "obsidian_clip",
    code: "denied",
    errorName: "NotAllowedError",
  });
  const pendingReclaim = optionsB.ctx.pbpReclaimLocalStorage(["misc"]);
  await wroteToDisk;
  const reclaimed1 = plain(await pendingReclaim);
  assert.equal(reclaimed1.removed.misc.keys.includes("pbpDiagErrors"), true);
  assert.equal("pbpDiagErrors" in origin.store, false);
  assert.deepEqual(plain(await optionsB.ctx.pbpReadDiagErrors()), []);

  // Case 2: Double clear around concurrent appends never resurrects H or N, and
  // subsequent post-clear writes X (221) + Y (222) both survive intact.
  const popupA2 = origin.makePageContext({ pathname: "/popup.html" });
  await popupA2.ctx.pbpRecordDiagError({ surface: "popup", op: "bookmark_delete", code: "network" });
  const [, , reclaim2] = await Promise.all([
    optionsB.ctx.pbpReclaimLocalStorage(["misc"]),
    popupA2.ctx.pbpRecordDiagError({ surface: "popup", op: "reader_handoff", code: "storage" }),
    pageC.ctx.pbpReclaimLocalStorage(["misc"]),
  ]);
  assert.ok(reclaim2);
  assert.equal("pbpDiagErrors" in origin.store, false);
  assert.deepEqual(plain(await optionsB.ctx.pbpReadDiagErrors()), []);

  await pageC.ctx.pbpRecordDiagError({ surface: "library", op: "vocab_delete", code: "failed", status: 221 });
  await popupA2.ctx.pbpRecordDiagError({ surface: "popup", op: "offline_retry", code: "send_failed", status: 222 });
  const postClear = plain(await optionsB.ctx.pbpReadDiagErrors());
  assert.deepEqual(postClear.map((r) => r.status), [221, 222]);
});

test("pbpDiagErrors: storage get/set failures degrade to null/[] without poisoning subsequent writes", async () => {
  const origin = createOriginHarness({
    pbpDiagErrors: [
      { ts: 1700000000100, surface: "ai", op: "ai_cache", code: "idb", errorName: "Error", status: null },
    ],
  });
  const page = origin.makePageContext({ pathname: "/options.html", failGet: true, failSet: true });

  // 1. Keyed get failure: both record and read degrade cleanly without rejecting.
  assert.equal(await page.ctx.pbpRecordDiagError({ surface: "ai", op: "ai_cache", code: "idb" }), null);
  assert.deepEqual(plain(await page.ctx.pbpReadDiagErrors()), []);

  // 2. Write-only failure (get works, set fails): record returns null, existing row remains readable.
  page.state.failGet = false;
  page.state.failSet = true;
  assert.equal(await page.ctx.pbpRecordDiagError({ surface: "options", op: "sync_migrate", code: "storage" }), null);
  const existing = plain(await page.ctx.pbpReadDiagErrors());
  assert.equal(existing.length, 1);
  assert.equal(existing[0].op, "ai_cache");

  // 3. Subsequent write after storage recovers succeeds and preserves queue liveness.
  page.state.failSet = false;
  const recovered = plain(await page.ctx.pbpRecordDiagError({ surface: "options", op: "wayback_clear", code: "storage" }));
  assert.ok(recovered && recovered.op === "wayback_clear");
  const afterRecovery = plain(await page.ctx.pbpReadDiagErrors());
  assert.deepEqual(afterRecovery.map((r) => r.op), ["ai_cache", "wayback_clear"]);
});

test("pbpDiagErrors: hostile getters, revoked proxies, throwing navigator.locks, and callback error names never throw or leak", async () => {
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

  // pbpSanitizeDiagErrors on an array with a throwing element getter and on a revoked Proxy:
  const poisonedArray = [
    { ts: 1700000000011, surface: "popup", op: "bookmark_delete", code: "network", errorName: "Error", status: null },
    null,
    { ts: 1700000000012, surface: "options", op: "storage_measure", code: "storage", errorName: "Error", status: null },
  ];
  Object.defineProperty(poisonedArray, 1, {
    get() { throw new TypeError("slot getter exploded"); },
  });
  const sanitizedPoisoned = plain(ctx.pbpSanitizeDiagErrors(poisonedArray));
  assert.deepEqual(sanitizedPoisoned.map((r) => r.op), ["bookmark_delete", "storage_measure"]);

  const revocable = Proxy.revocable([], {});
  revocable.revoke();
  assert.deepEqual(plain(ctx.pbpSanitizeDiagErrors(revocable.proxy)), []);

  // Host where reading navigator.locks itself throws SecurityError synchronously:
  const restrictedHost = makePageContext({ pathname: "/popup.html", throwingLocksGetter: true });
  const restrictedEntry = plain(await restrictedHost.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "obsidian_clip",
    code: "denied",
    errorName: "SecurityError",
  }));
  assert.ok(restrictedEntry && restrictedEntry.op === "obsidian_clip");
  const restrictedRead = plain(await restrictedHost.ctx.pbpReadDiagErrors());
  assert.equal(restrictedRead[restrictedRead.length - 1].op, "obsidian_clip");

  // Lock adapter that invokes callback synchronously and then throws synchronously must not double-enqueue:
  const syncThrowLockHost = makePageContext({ pathname: "/popup.html" });
  syncThrowLockHost.ctx.navigator.locks = {
    request(_name, cb) {
      cb();
      throw new Error("adapter threw after invoking callback");
    },
  };
  await makePageContext({ pathname: "/options.html" }).ctx.pbpReclaimLocalStorage(["misc"]);
  const onceOnly = plain(await syncThrowLockHost.ctx.pbpRecordDiagError({
    surface: "popup",
    op: "bookmark_delete",
    code: "network",
    status: 503,
  }));
  assert.ok(onceOnly && onceOnly.status === 503);
  const onceRows = plain(await syncThrowLockHost.ctx.pbpReadDiagErrors());
  assert.equal(onceRows.length, 1, "post-callback sync throw in custom lock adapter must not double-write");

  // Accessor property on input record:
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
  assert.equal(fromGetter.status, null);
  assert.equal(statusReads, 599, "accessor getter must never be invoked");

  const throwingGetter = {
    surface: "popup",
    get op() { throw new Error("getter exploded"); },
  };
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

test("pbpDiagErrors: Jina cache surface attribution and pbpMeasureLocalStorage survive throwing surface getters", async () => {
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
  const jinaOpts = {
    cacheDuration: 0,
    get diagSurface() { throw new TypeError("diagSurface getter exploded"); },
  };
  const jinaRes = plain(await popupPage.ctx.fetchJinaMarkdown("https://example.com/a", jinaOpts));
  assert.equal(jinaRes.markdown, "# Hello");
  let rows = plain(await popupPage.ctx.pbpReadDiagErrors());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, "popup");
  assert.equal(rows[0].op, "jina_cache_read");

  // pbpMeasureLocalStorage when get(null) throws AND opts.surface is a throwing getter:
  const optPage = origin.makePageContext({ pathname: "/options.html" });
  const origOptGet = optPage.local.get;
  optPage.local.get = async (keys) => {
    if (keys === null) throw new DOMException("read null failed", "NotReadableError");
    return origOptGet(keys);
  };
  const measureOpts = {
    get surface() { throw new TypeError("surface getter exploded"); },
  };
  const measured = plain(await optPage.ctx.pbpMeasureLocalStorage(measureOpts));
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
