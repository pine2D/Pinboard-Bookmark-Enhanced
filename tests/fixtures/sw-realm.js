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

  function loadScript(doc, src) {
    return new Promise((resolve, reject) => {
      const s = doc.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load runtime script: " + src));
      doc.head.appendChild(s);
    });
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
    // Stub: WorkerGlobalScope.importScripts does not exist on Window; the
    // dependency scripts are loaded via <script src> below in identical order.
    win.importScripts = (...files) => { win.__importedScripts.push(...files); };
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
    if (options.beforeBackground) await options.beforeBackground(win, mock);
    if (!options.depsOnly) {
      await loadScript(doc, base + "background.js");
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
      // Stop periodic timers without removing the iframe before coverage stops.
      dispose() {
        try {
          const maxId = win.setTimeout(() => {}, 0);
          for (let id = 1; id <= maxId; id++) { win.clearTimeout(id); win.clearInterval(id); }
        } catch { /* swallow-ok: realm teardown best-effort */ }
      },
    };
  }

  let _popupTemplate = null;
  async function loadPopupTemplate() {
    if (_popupTemplate) return _popupTemplate;
    const base = new URL("../", document.baseURI).href;
    const response = await fetch(base + "popup.html");
    if (!response.ok) throw new Error("Cannot load popup.html: " + response.status);
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    const sources = [...parsed.querySelectorAll("script[defer][src]")]
      .map((s) => new URL(s.getAttribute("src"), response.url).href);
    parsed.querySelectorAll("script").forEach((s) => s.remove());
    _popupTemplate = { bodyHtml: parsed.body.innerHTML, sources };
    return _popupTemplate;
  }

  // Boots popup.html's markup + deferred runtime scripts in consumer order
  // inside an isolated same-origin <iframe>, AFTER DOMContentLoaded has already
  // fired so popup.js's automatic session/tab bootstrap stays dormant unless
  // explicitly invoked.
  async function bootPopup(options = {}) {
    const tpl = await loadPopupTemplate();
    const iframe = document.createElement("iframe");
    const emptyUrl = new URL("fixtures/empty-realm.html", document.baseURI).href;
    await new Promise((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error("failed to load empty-realm.html"));
      iframe.src = emptyUrl;
      ensureHost().appendChild(iframe);
    });
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    doc.body.innerHTML = tpl.bodyHtml;

    let onReload = options.onReload || null;
    if (win.navigation && typeof win.navigation.addEventListener === "function") {
      win.navigation.addEventListener("navigate", (e) => {
        if (e.navigationType === "reload") {
          if (e.cancelable) e.preventDefault();
          if (typeof onReload === "function") onReload();
        }
      });
    }

    const mock = globalThis.pbpChromeMock.create(options.mock || {});
    win.chrome = mock.chrome;
    win.fetch = options.fetch || (async (input) => {
      throw new Error("unmocked fetch in popup realm: " + String(input || ""));
    });

    if (options.beforeScripts) await options.beforeScripts(win, mock, doc);
    for (const src of tpl.sources) {
      await loadScript(doc, src);
    }
    if (options.afterBoot) await options.afterBoot(win, mock, doc);

    return {
      win,
      doc,
      mock,
      resetBody() { doc.body.innerHTML = tpl.bodyHtml; },
      setOnReload(fn) { onReload = fn; },
      get(expr) { return win.eval(expr); },
      set(ident, value) {
        win.__pbpSetValue = value;
        try { win.eval(`${ident} = window.__pbpSetValue`); }
        finally { delete win.__pbpSetValue; }
      },
      dispose() {
        try {
          const maxId = win.setTimeout(() => {}, 0);
          for (let id = 1; id <= maxId; id++) { win.clearTimeout(id); win.clearInterval(id); }
        } catch { /* swallow-ok: realm teardown best-effort */ }
      },
    };
  }

  globalThis.pbpSwRealm = { SW_DEPS, boot, bootPopup, loadScript };
})();
