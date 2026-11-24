// Real-script Service Worker realm loader for tests/*.html.
// Boots the shipped SW dependency chain + background.js inside an isolated
// same-origin <iframe> via real <script src> tags, backed by chrome-mock.js.
//
// Why an iframe + importScripts stub:
//   1. Multiple test cases often model consecutive MV3 worker generations or
//      independent module state (_settingsCache, statusCache, _batchRunning,
//      driveScopeEpoch). Each iframe gives a fresh global realm while still
//      loading every runtime file by URL so V8 credits real function coverage.
//   2. importScripts() only exists on WorkerGlobalScope; inside a document
//      realm the dependency scripts are loaded ahead of background.js in the
//      same order, and importScripts records the list background.js requested.
(function () {
  "use strict";

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const SW_DEPS = [
    "i18n.js", "shared.js", "tag-gov-save.js", "bookmark-services.js",
    "vocab-store.js", "vocab-gdrive.js", "notes-sync.js", "notes-gdrive.js",
    "restore-points.js", "ai-cache.js", "dict-archive.js", "dict-archive-gdrive.js",
    "ask-archive.js", "ask-archive-gdrive.js", "ai.js", "jina.js", "wayback.js",
  ];

  function ensureHost() {
    let host = document.getElementById("pbp-sw-realms");
    if (!host) {
      host = document.createElement("div");
      host.id = "pbp-sw-realms";
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0;pointer-events:none;overflow:hidden";
      document.body.appendChild(host);
    }
    return host;
  }

  function loadScript(doc, src, onCreated) {
    return new Promise((resolve, reject) => {
      const s = doc.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load runtime script: " + src));
      if (onCreated) onCreated(s);
      doc.head.appendChild(s);
    });
  }

  function isTopLevelScriptStackActive(win, doc, getActiveScript, bgUrl) {
    const expectedEl = getActiveScript();
    if (!expectedEl) return true;
    if (doc.currentScript !== expectedEl) return false;
    const prevPrepare = win.Error.prepareStackTrace;
    const prevLimit = win.Error.stackTraceLimit;
    let frames = null;
    try {
      win.Error.stackTraceLimit = Infinity;
      win.Error.prepareStackTrace = (_err, sites) => sites.map((s) => ({
        file: s.getFileName() || s.getScriptNameOrSourceURL() || "",
        fn: s.getFunctionName(),
        line: typeof s.getEnclosingLineNumber === "function" ? s.getEnclosingLineNumber() : 1,
        col: typeof s.getEnclosingColumnNumber === "function" ? s.getEnclosingColumnNumber() : 1,
      }));
      frames = new win.Error().stack;
    } finally {
      win.Error.prepareStackTrace = prevPrepare;
      win.Error.stackTraceLimit = prevLimit;
    }
    if (!Array.isArray(frames)) return true;
    const bgFrames = frames.filter((f) => f.file === bgUrl || f.file.endsWith("/background.js"));
    if (!bgFrames.length) return true;
    const rootFrame = bgFrames[bgFrames.length - 1];
    return rootFrame.fn === null && rootFrame.line === 1 && rootFrame.col === 1;
  }

  function gateMockEventListenersToScript(mockChrome, win, doc, getActiveScript, bgUrl) {
    const originals = [];
    const deferred = [];
    let active = true;
    const seen = new Set();
    const visit = (obj) => {
      if (!obj || typeof obj !== "object" || seen.has(obj)) return;
      seen.add(obj);
      if (typeof obj.addListener === "function" && typeof obj.hasListener === "function") {
        const origAdd = obj.addListener.bind(obj);
        originals.push(() => { obj.addListener = origAdd; });
        obj.addListener = (...args) => {
          if (active && !isTopLevelScriptStackActive(win, doc, getActiveScript, bgUrl)) {
            deferred.push(() => origAdd(...args));
            return;
          }
          return origAdd(...args);
        };
      }
      for (const key of Object.keys(obj)) {
        try { visit(obj[key]); } catch (_) { /* ignore getter throws on mock handles */ }
      }
    };
    visit(mockChrome);
    return {
      releaseAndReplay() {
        if (!active) return;
        active = false;
        for (const restore of originals) restore();
        while (deferred.length) deferred.shift()();
      },
    };
  }

  // options:
  //   mock: options passed to pbpChromeMock.create(...)
  //   beforeDeps(win, mock): runs before any runtime script loads
  //   beforeBackground(win, mock): runs after SW_DEPS load, before background.js
  //   afterBoot(win, mock): runs right after background.js top-level finishes
  //   depsOnly: true to load SW_DEPS without background.js
  async function boot(options = {}) {
    const iframe = document.createElement("iframe");
    ensureHost().appendChild(iframe);
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    doc.open();
    doc.write("<!DOCTYPE html><html><head><meta charset='UTF-8'></head><body></body></html>");
    doc.close();

    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.__importedScripts = [];
    let syncSampled = false;
    const realQueueMicrotask = win.queueMicrotask.bind(win);
    const realPromiseThen = win.Promise.prototype.then;
    const restoreBootMicrotaskHooks = () => {
      win.queueMicrotask = realQueueMicrotask;
      win.Promise.prototype.then = realPromiseThen;
    };
    let ensureBootSyncAtQueueHeadImpl = null;
    const ensureBootSyncAtQueueHead = () => {
      if (ensureBootSyncAtQueueHeadImpl) ensureBootSyncAtQueueHeadImpl();
    };
    // Stub: WorkerGlobalScope.importScripts does not exist on Window; the
    // dependency scripts are loaded via <script src> below in identical order.
    win.importScripts = (...files) => {
      win.__importedScripts.push(...files);
      ensureBootSyncAtQueueHead();
    };
    // Stub: prevent accidental real network fetches in background boot paths
    // unless a test installs its own win.fetch.
    win.fetch = options.fetch || (async (input) => {
      const href = String(input || "");
      if (href.startsWith("chrome-extension://") && href.endsWith(".png")) {
        throw new Error("icon PNG fetch disabled in unit test realm");
      }
      throw new Error("unmocked fetch in SW realm: " + href);
    });

    if (options.beforeDeps) await options.beforeDeps(win, mock);
    const base = new URL("../", document.baseURI).href;
    for (const file of options.deps || SW_DEPS) {
      await loadScript(doc, base + file);
    }
    const bgUrl = base + "background.js";
    let bgScriptEl = null;
    const listenerGate = !options.depsOnly && typeof options.afterBootSync === "function"
      ? gateMockEventListenersToScript(mock.chrome, win, doc, () => bgScriptEl, bgUrl)
      : null;
    if (options.beforeBackground) await options.beforeBackground(win, mock);
    if (!options.depsOnly) {
      const finishBootSync = () => {
        if (typeof options.afterBootSync === "function") {
          options.afterBootSync(win, mock);
        }
        if (listenerGate) listenerGate.releaseAndReplay();
      };
      if (options.backgroundSource === undefined) {
        const invokeBootSyncOnce = () => {
          if (syncSampled) return;
          syncSampled = true;
          restoreBootMicrotaskHooks();
          finishBootSync();
          win.__pbpMicrotaskCheckpointRan = true;
        };
        ensureBootSyncAtQueueHeadImpl = () => {
          if (syncSampled || typeof options.afterBootSync !== "function") return;
          syncSampled = true;
          win.__pbpMicrotaskCheckpointRan = false;
          restoreBootMicrotaskHooks();
          realQueueMicrotask(() => {
            finishBootSync();
            win.__pbpMicrotaskCheckpointRan = true;
          });
        };
        if (typeof options.afterBootSync === "function") {
          win.queueMicrotask = (cb) => {
            ensureBootSyncAtQueueHead();
            return realQueueMicrotask(cb);
          };
          win.Promise.prototype.then = function (onFulfilled, onRejected) {
            ensureBootSyncAtQueueHead();
            return realPromiseThen.call(this, onFulfilled, onRejected);
          };
        }
        try {
          await loadScript(doc, bgUrl, (el) => { bgScriptEl = el; });
        } finally {
          restoreBootMicrotaskHooks();
          if (listenerGate && !syncSampled) {
            win.__pbpMicrotaskCheckpointRan = false;
            invokeBootSyncOnce();
          } else if (listenerGate) {
            listenerGate.releaseAndReplay();
          }
        }
      } else {
        win.__pbpMicrotaskCheckpointRan = false;
        win.queueMicrotask(() => { win.__pbpMicrotaskCheckpointRan = true; });
        let bootErr = null;
        const onErr = (ev) => { bootErr = ev.error || new Error(ev.message || "background.js top-level error"); };
        win.addEventListener("error", onErr);
        try {
          const s = doc.createElement("script");
          bgScriptEl = s;
          s.textContent = options.backgroundSource + "\n//# sourceURL=" + bgUrl;
          doc.head.appendChild(s);
        } finally {
          win.removeEventListener("error", onErr);
        }
        if (bootErr) {
          if (listenerGate) listenerGate.releaseAndReplay();
          throw bootErr;
        }
        finishBootSync();
      }
      const expectedDeps = options.deps || SW_DEPS;
      if (win.__importedScripts.length !== expectedDeps.length ||
          expectedDeps.some((file, idx) => win.__importedScripts[idx] !== file)) {
        throw new Error(
          `SW_DEPS drift: background.js importScripts(${JSON.stringify(win.__importedScripts)}) !== ${JSON.stringify(expectedDeps)}`,
        );
      }
    }
    if (options.afterBoot) await options.afterBoot(win, mock);

    return {
      win,
      mock,
      // Read or assign top-level const/let lexical bindings inside the SW realm.
      get(expr) { return win.eval(expr); },
      set(ident, value) {
        win.__pbpSetValue = value;
        try { win.eval(`${ident} = window.__pbpSetValue`); }
        finally { delete win.__pbpSetValue; }
      },
      // Stop periodic timers and close cached IDB handles without removing the iframe before coverage stops.
      dispose(opts = {}) {
        try {
          const maxId = win.setTimeout(() => {}, 0);
          for (let id = 1; id <= maxId; id++) { win.clearTimeout(id); win.clearInterval(id); }
        } catch { /* swallow-ok: realm teardown best-effort */ }
        try {
          win.eval(`
            for (const p of [
              typeof _pbpVocabDbPromise !== "undefined" && _pbpVocabDbPromise,
              typeof _pbpAiDbPromise !== "undefined" && _pbpAiDbPromise,
              typeof _pbpPackDbPromise !== "undefined" && _pbpPackDbPromise,
              typeof _pbpMultiDbPromise !== "undefined" && _pbpMultiDbPromise,
            ]) {
              if (p && typeof p.then === "function") p.then((db) => { try { db && db.close(); } catch (_) {} }, () => {});
            }
            if (typeof _pbpVocabDbPromise !== "undefined") _pbpVocabDbPromise = null;
            if (typeof _pbpAiDbPromise !== "undefined") _pbpAiDbPromise = null;
          `);
        } catch { /* swallow-ok: realm IDB teardown best-effort */ }
        if (opts && opts.removeIframe) {
          try {
            if (iframe && typeof iframe.remove === "function") iframe.remove();
          } catch { /* swallow-ok: iframe removal best-effort */ }
        }
      },
    };
  }

  function defaultExtensionFetch(realmLabel, base) {
    return async (input) => {
      const href = String(input || "");
      const m = href.match(/\/(_locales\/[^/]+\/messages\.json)$/);
      if (m) return nativeFetch(base + m[1]);
      if (href.startsWith("chrome-extension://") && href.endsWith(".png")) {
        throw new Error("icon PNG fetch disabled in unit test realm");
      }
      throw new Error(`unmocked fetch in ${realmLabel} realm: ${href}`);
    };
  }

  async function createEmptyIframe(search = "") {
    const iframe = document.createElement("iframe");
    const emptyUrl = new URL("fixtures/empty-realm.html", document.baseURI).href;
    await new Promise((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error("failed to load empty-realm.html"));
      iframe.src = emptyUrl;
      ensureHost().appendChild(iframe);
    });
    if (search) {
      iframe.contentWindow.history.replaceState(null, "", emptyUrl + search);
    }
    const baseEl = iframe.contentDocument.createElement("base");
    baseEl.href = new URL("../", document.baseURI).href;
    iframe.contentDocument.head.appendChild(baseEl);
    return iframe;
  }

  function wireReloadTrap(win, getHandler) {
    if (win.navigation && typeof win.navigation.addEventListener === "function") {
      win.navigation.addEventListener("navigate", (e) => {
        if (e.navigationType === "reload") {
          if (e.cancelable) e.preventDefault();
          const fn = getHandler();
          if (typeof fn === "function") fn();
        }
      });
    }
  }

  function realmHandle(win, doc, mock, extra = {}) {
    return {
      win,
      doc,
      mock,
      ...extra,
      get(expr) { return win.eval(expr); },
      set(ident, value) {
        win.__pbpSetValue = value;
        try { win.eval(`${ident} = window.__pbpSetValue`); }
        finally { delete win.__pbpSetValue; }
      },
      dispose(opts = {}) {
        try {
          const maxId = win.setTimeout(() => {}, 0);
          for (let id = 1; id <= maxId; id++) { win.clearTimeout(id); win.clearInterval(id); }
        } catch { /* swallow-ok: realm teardown best-effort */ }
        try {
          win.eval(`
            for (const p of [
              typeof _pbpVocabDbPromise !== "undefined" && _pbpVocabDbPromise,
              typeof _pbpAiDbPromise !== "undefined" && _pbpAiDbPromise,
              typeof _pbpPackDbPromise !== "undefined" && _pbpPackDbPromise,
              typeof _pbpMultiDbPromise !== "undefined" && _pbpMultiDbPromise,
            ]) {
              if (p && typeof p.then === "function") p.then((db) => { try { db && db.close(); } catch (_) {} }, () => {});
            }
            if (typeof _pbpVocabDbPromise !== "undefined") _pbpVocabDbPromise = null;
            if (typeof _pbpAiDbPromise !== "undefined") _pbpAiDbPromise = null;
          `);
        } catch { /* swallow-ok: realm IDB teardown best-effort */ }
        if (opts && opts.removeIframe) {
          try {
            if (extra.iframe && typeof extra.iframe.remove === "function") extra.iframe.remove();
          } catch { /* swallow-ok: iframe removal best-effort */ }
        }
      },
    };
  }

  async function loadStylesheet(doc, href, media) {
    await new Promise((resolve, reject) => {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      if (media) link.media = media;
      link.href = href;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error("failed to load stylesheet: " + href));
      doc.head.appendChild(link);
    });
  }

  async function loadSurfaceTemplate(pageFile) {
    const base = new URL("../", document.baseURI).href;
    const response = await nativeFetch(base + pageFile);
    if (!response.ok) throw new Error(`Cannot load ${pageFile}: ${response.status}`);
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    const styles = [...parsed.querySelectorAll('link[rel="stylesheet"][href]')]
      .map((l) => ({ href: new URL(l.getAttribute("href"), response.url).href, media: l.getAttribute("media") || "" }));
    const earlySources = [...parsed.querySelectorAll("script[src]:not([defer])")]
      .map((s) => new URL(s.getAttribute("src"), response.url).href);
    const sources = [...parsed.querySelectorAll("script[defer][src]")]
      .map((s) => new URL(s.getAttribute("src"), response.url).href);
    parsed.querySelectorAll("script").forEach((s) => s.remove());
    return { bodyHtml: parsed.body.innerHTML, styles, earlySources, sources, base };
  }

  let _popupTemplate = null;
  async function loadPopupTemplate() {
    if (!_popupTemplate) _popupTemplate = await loadSurfaceTemplate("popup.html");
    return _popupTemplate;
  }

  let _optionsTemplate = null;
  async function loadOptionsTemplate() {
    if (!_optionsTemplate) _optionsTemplate = await loadSurfaceTemplate("options.html");
    return _optionsTemplate;
  }

  let _readerTemplate = null;
  async function loadReaderTemplate() {
    if (!_readerTemplate) _readerTemplate = await loadSurfaceTemplate("md-preview.html");
    return _readerTemplate;
  }

  // Loads an explicit list of repo-root runtime scripts inside an isolated
  // same-origin <iframe> backed by chrome-mock.js.
  async function loadRealmScripts(files, options = {}) {
    const base = new URL("../", document.baseURI).href;
    const iframe = await createEmptyIframe(options.search || "");
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    let onReload = options.onReload || null;
    wireReloadTrap(win, () => onReload);
    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.fetch = options.fetch || defaultExtensionFetch("script", base);
    if (options.bodyHtml) doc.body.innerHTML = options.bodyHtml;
    if (options.beforeScripts) await options.beforeScripts(win, mock, doc);
    for (const file of files) {
      const src = /^https?:|^chrome-extension:/.test(file) ? file : base + String(file).replace(/^(\.\.\/)+/, "");
      await loadScript(doc, src);
    }
    if (options.afterBoot) await options.afterBoot(win, mock, doc);
    return realmHandle(win, doc, mock, {
      iframe,
      setOnReload(fn) { onReload = fn; },
    });
  }

  // Boots popup.html's markup + deferred runtime scripts in consumer order
  // inside an isolated same-origin <iframe>, AFTER DOMContentLoaded has already
  // fired so popup.js's automatic session/tab bootstrap stays dormant unless
  // explicitly invoked.
  async function bootPopup(options = {}) {
    const tpl = await loadPopupTemplate();
    const iframe = await createEmptyIframe(options.search || "");
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    doc.body.innerHTML = tpl.bodyHtml;

    let onReload = options.onReload || null;
    wireReloadTrap(win, () => onReload);

    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.fetch = options.fetch || defaultExtensionFetch("popup", tpl.base);

    if (options.beforeScripts) await options.beforeScripts(win, mock, doc);
    for (const src of tpl.sources) {
      await loadScript(doc, src);
    }
    if (options.afterBoot) await options.afterBoot(win, mock, doc);

    return realmHandle(win, doc, mock, {
      iframe,
      resetBody() { doc.body.innerHTML = tpl.bodyHtml; },
      setOnReload(fn) { onReload = fn; },
    });
  }

  // Boots options.html's markup + deferred runtime scripts in consumer order.
  // When autoInit !== false (default true), dispatches DOMContentLoaded and
  // awaits every registered DOMContentLoaded listener's returned promise so
  // options.js's async initialization settles before returning.
  async function bootOptions(options = {}) {
    const tpl = await loadOptionsTemplate();
    const iframe = await createEmptyIframe(options.search || "");
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (options.withStyles) {
      for (const st of tpl.styles) await loadStylesheet(doc, st.href, st.media);
    }
    doc.body.innerHTML = tpl.bodyHtml;

    let onReload = options.onReload || null;
    wireReloadTrap(win, () => onReload);

    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.fetch = options.fetch || defaultExtensionFetch("options", tpl.base);

    const dclWrapped = new WeakMap();
    const dclPending = [];
    const origAdd = doc.addEventListener.bind(doc);
    const origRemove = doc.removeEventListener.bind(doc);
    doc.addEventListener = function (type, listener, opts) {
      if (type === "DOMContentLoaded" && typeof listener === "function") {
        let wrapped = dclWrapped.get(listener);
        if (!wrapped) {
          wrapped = function (ev) {
            const ret = listener.call(this, ev);
            if (ret && typeof ret.then === "function") dclPending.push(ret);
            return ret;
          };
          dclWrapped.set(listener, wrapped);
        }
        return origAdd(type, wrapped, opts);
      }
      return origAdd(type, listener, opts);
    };
    doc.removeEventListener = function (type, listener, opts) {
      if (type === "DOMContentLoaded" && typeof listener === "function") {
        const wrapped = dclWrapped.get(listener);
        if (wrapped) origRemove(type, wrapped, opts);
      }
      return origRemove(type, listener, opts);
    };

    if (options.beforeScripts) await options.beforeScripts(win, mock, doc);
    if (options.withEarlyTheme !== false) {
      for (const src of tpl.earlySources) await loadScript(doc, src);
    }
    Object.defineProperty(doc, "readyState", { configurable: true, value: "interactive" });
    try {
      for (const src of tpl.sources) await loadScript(doc, src);
    } finally {
      delete doc.readyState;
    }

    let initialized = false;
    async function runInit() {
      if (initialized) return;
      initialized = true;
      doc.addEventListener = origAdd;
      dclPending.length = 0;
      const ev = new win.Event("DOMContentLoaded", { bubbles: true });
      doc.dispatchEvent(ev);
      await Promise.all(dclPending.splice(0));
    }
    if (options.autoInit !== false) await runInit();
    if (options.afterBoot) await options.afterBoot(win, mock, doc);

    return realmHandle(win, doc, mock, {
      iframe,
      runInit,
      resetBody() { doc.body.innerHTML = tpl.bodyHtml; },
      setOnReload(fn) { onReload = fn; },
    });
  }

  // Boots md-preview.html's markup + deferred runtime scripts in consumer order
  // with readyState="interactive" while scripts load, then fires DOMContentLoaded
  // and awaits md-preview.js's main async IIFE completion (__pbpReaderBootPromise).
  async function bootReader(options = {}) {
    const tpl = await loadReaderTemplate();
    const iframe = await createEmptyIframe(options.search !== undefined ? options.search : "?k=fixture");
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (options.withStyles) {
      for (const st of tpl.styles) await loadStylesheet(doc, st.href, st.media);
    }
    doc.body.innerHTML = tpl.bodyHtml;

    let onReload = options.onReload || null;
    wireReloadTrap(win, () => onReload);

    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.fetch = options.fetch || defaultExtensionFetch("reader", tpl.base);

    if (options.beforeScripts) await options.beforeScripts(win, mock, doc);
    if (options.withEarlyTheme !== false) {
      for (const src of tpl.earlySources) await loadScript(doc, src);
    }
    Object.defineProperty(doc, "readyState", { configurable: true, value: "interactive" });
    try {
      for (const src of tpl.sources) await loadScript(doc, src);
    } finally {
      delete doc.readyState;
    }
    doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
    if (options.awaitBoot !== false && win.__pbpReaderBootPromise) {
      await win.__pbpReaderBootPromise;
    }
    if (options.afterBoot) await options.afterBoot(win, mock, doc);

    return realmHandle(win, doc, mock, {
      iframe,
      resetBody() { doc.body.innerHTML = tpl.bodyHtml; },
      setOnReload(fn) { onReload = fn; },
    });
  }

  globalThis.pbpSwRealm = { SW_DEPS, boot, bootPopup, bootOptions, bootReader, loadRealmScripts, loadScript };
})();
