// Shared chrome.* mock for test pages that load the REAL runtime file by
// <script src>. Plain script, no dependencies. Load it before the runtime
// scripts, then:
//
//   const mock = pbpChromeMock.install({ messages, storage: { local: {...} } });
//   mock.onSendMessage((message, sender) => reply);   // the other end of runtime.sendMessage
//   mock.failNext("storage.local.set", { quota: true }); // inject a failure on the next call
//   mock.calls                                         // every API call: { api, args }
//
// Every async API takes a callback or, without one, returns a promise. A
// failure reaches a callback through chrome.runtime.lastError, set only while
// that callback runs, and rejects the promise form with an Error (lastError is
// not set then). Shapes follow the Chrome extension reference, cited per API;
// they are not taken from the code under test.
//   https://developer.chrome.com/docs/extensions/reference/api/runtime#property-lastError
//   https://developer.chrome.com/docs/extensions/develop/concepts/promises
(function () {
  "use strict";
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // https://developer.chrome.com/docs/extensions/reference/api/events#type-Event
  function makeEvent(name, record) {
    const listeners = [];
    return {
      addListener(fn) { record(name + ".addListener", [fn]); if (!listeners.includes(fn)) listeners.push(fn); },
      removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      hasListener(fn) { return listeners.includes(fn); },
      hasListeners() { return listeners.length > 0; },
      // test side: call every listener, return their return values
      dispatch(...args) { return listeners.slice().map((fn) => fn(...args)); },
      get listeners() { return listeners.slice(); },
    };
  }

  function create(options = {}) {
    const calls = [];
    const failures = new Map(); // api -> [failure, ...]
    const unchecked = [];
    const record = (api, args) => { calls.push({ api, args: args.slice() }); };
    const chrome = {};

    // ---- runtime.lastError: set only while a callback runs ----
    let lastError;
    let lastErrorRead = false;
    const runtime = {};
    Object.defineProperty(runtime, "lastError", {
      configurable: true, enumerable: true,
      get() { lastErrorRead = true; return lastError; },
    });

    function toMessage(failure) {
      if (failure && failure.quota) return failure.quota === true ? "QUOTA_BYTES quota exceeded" : String(failure.quota);
      if (failure && typeof failure.message === "string") return failure.message;
      return String(failure);
    }
    function takeFailure(api) {
      const list = failures.get(api);
      if (!list || !list.length) return null;
      const f = list.shift();
      if (!list.length) failures.delete(api);
      return f;
    }
    function deliver(cb, error, value) {
      if (!error) { cb(value); return; }
      lastError = { message: error.message };
      lastErrorRead = false;
      try { cb(); } finally {
        // Chrome logs "Unchecked runtime.lastError" when the callback never read it.
        if (!lastErrorRead) unchecked.push(error.message);
        lastError = undefined;
      }
    }
    // One async API call: callback form or promise form.
    function invoke(api, args, run) {
      const list = Array.from(args);
      const cb = typeof list[list.length - 1] === "function" ? list.pop() : null;
      record(api, list);
      const failure = takeFailure(api);
      const p = failure
        ? Promise.reject(new Error(toMessage(failure)))
        : Promise.resolve().then(() => run(...list));
      if (!cb) return p;
      p.then((v) => deliver(cb, null, v), (e) => deliver(cb, e instanceof Error ? e : new Error(String(e))));
      return undefined;
    }

    // ---- storage ----
    // https://developer.chrome.com/docs/extensions/reference/api/storage#type-StorageArea
    // get(keys?): null/undefined = everything; string or string[] = those keys;
    // object = keys with defaults. Values are serialized (JSON-like).
    // onChanged(changes, areaName): changes[key] = { oldValue?, newValue? },
    // only for keys whose value changed.
    // https://developer.chrome.com/docs/extensions/reference/api/storage#event-onChanged
    // Quotas (bytes = key length + JSON length of the value):
    // https://developer.chrome.com/docs/extensions/reference/api/storage#property-sync
    const QUOTAS = {
      local: { QUOTA_BYTES: 10485760 },
      session: { QUOTA_BYTES: 10485760 },
      sync: { QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 },
    };
    const stores = {};
    const globalChanged = makeEvent("storage.onChanged", record);
    const sizeOf = (key, value) => key.length + JSON.stringify(value).length;
    function makeArea(area) {
      const data = new Map(Object.entries(clone((options.storage && options.storage[area]) || {})));
      stores[area] = data;
      const onChanged = makeEvent("storage." + area + ".onChanged", record);
      const notify = (changes) => {
        if (!Object.keys(changes).length) return;
        // Both events fire; listeners get their own copies.
        onChanged.dispatch(clone(changes));
        globalChanged.dispatch(clone(changes), area);
      };
      const q = QUOTAS[area];
      const obj = {
        ...q,
        get(...args) {
          return invoke("storage." + area + ".get", args, (keys) => {
            const out = {};
            if (keys === null || keys === undefined) { for (const [k, v] of data) out[k] = clone(v); return out; }
            if (typeof keys === "string") keys = [keys];
            if (Array.isArray(keys)) { for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k)); return out; }
            if (typeof keys === "object") {
              for (const [k, d] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(d);
              return out;
            }
            throw new Error("Error in invocation of storage.get(optional [string|array|object] keys, function callback)");
          });
        },
        set(...args) {
          return invoke("storage." + area + ".set", args, (items) => {
            const next = new Map(data);
            for (const [k, v] of Object.entries(items || {})) {
              const value = clone(v);
              if (value === undefined) continue;
              if (q.QUOTA_BYTES_PER_ITEM && sizeOf(k, value) > q.QUOTA_BYTES_PER_ITEM) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
              next.set(k, value);
            }
            if (q.MAX_ITEMS && next.size > q.MAX_ITEMS) throw new Error("MAX_ITEMS quota exceeded");
            let total = 0; for (const [k, v] of next) total += sizeOf(k, v);
            if (total > q.QUOTA_BYTES && !(area === "local" && options.unlimitedStorage)) throw new Error("QUOTA_BYTES quota exceeded");
            const changes = {};
            for (const [k, v] of Object.entries(items || {})) {
              const value = clone(v);
              if (value === undefined) continue;
              const had = data.has(k);
              if (had && same(data.get(k), value)) continue;
              changes[k] = had ? { oldValue: clone(data.get(k)), newValue: value } : { newValue: value };
            }
            for (const [k, v] of next) data.set(k, v);
            notify(changes);
            return undefined;
          });
        },
        remove(...args) {
          return invoke("storage." + area + ".remove", args, (keys) => {
            const changes = {};
            for (const k of typeof keys === "string" ? [keys] : keys || []) {
              if (data.has(k)) { changes[k] = { oldValue: clone(data.get(k)) }; data.delete(k); }
            }
            notify(changes);
            return undefined;
          });
        },
        clear(...args) {
          return invoke("storage." + area + ".clear", args, () => {
            const changes = {};
            for (const [k, v] of data) changes[k] = { oldValue: clone(v) };
            data.clear();
            notify(changes);
            return undefined;
          });
        },
        getBytesInUse(...args) {
          return invoke("storage." + area + ".getBytesInUse", args, (keys) => {
            let total = 0;
            const list = keys === null || keys === undefined ? [...data.keys()] : typeof keys === "string" ? [keys] : keys;
            for (const k of list) if (data.has(k)) total += sizeOf(k, data.get(k));
            return total;
          });
        },
        onChanged,
      };
      if (area === "session") obj.setAccessLevel = (...args) => invoke("storage.session.setAccessLevel", args, () => undefined);
      return obj;
    }
    chrome.storage = { local: makeArea("local"), sync: makeArea("sync"), session: makeArea("session"), onChanged: globalChanged };

    // ---- runtime ----
    // https://developer.chrome.com/docs/extensions/reference/api/runtime
    const extensionId = options.id || "abcdefghijklmnopabcdefghijklmnop";
    let sendHandler = null;
    runtime.id = extensionId;
    runtime.getURL = (path) => "chrome-extension://" + extensionId + "/" + String(path || "").replace(/^\//, "");
    runtime.getManifest = () => clone(options.manifest || { manifest_version: 3, name: "test", version: "0.0.0" });
    runtime.onMessage = makeEvent("runtime.onMessage", record);
    runtime.onInstalled = makeEvent("runtime.onInstalled", record);
    runtime.onStartup = makeEvent("runtime.onStartup", record);
    // sendMessage([extensionId], message, [options], [callback]): the answer
    // comes from the other end (mock.onSendMessage). With no receiver Chrome
    // fails with "Could not establish connection. Receiving end does not exist."
    // A receiver that answers nothing gives undefined.
    // https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
    runtime.sendMessage = (...args) => invoke("runtime.sendMessage", args, async (...rest) => {
      const message = typeof rest[0] === "string" && rest.length > 1 ? rest[1] : rest[0];
      if (!sendHandler) throw new Error("Could not establish connection. Receiving end does not exist.");
      const reply = await sendHandler(clone(message), { id: extensionId });
      return clone(reply);
    });

    // Test side: deliver a message to this context's runtime.onMessage
    // listeners, as Chrome does: (message, sender, sendResponse); a listener
    // keeps the channel open by returning true.
    // https://developer.chrome.com/docs/extensions/develop/concepts/messaging
    function dispatchMessage(message, sender = { id: extensionId }) {
      return new Promise((resolve) => {
        let settled = false;
        const sendResponse = (r) => { if (!settled) { settled = true; resolve(clone(r)); } };
        const results = runtime.onMessage.dispatch(clone(message), sender, sendResponse);
        if (!results.some((r) => r === true) && !settled) { settled = true; resolve(undefined); }
      });
    }

    // ---- alarms ----
    // https://developer.chrome.com/docs/extensions/reference/api/alarms#type-Alarm
    // Alarm: { name, scheduledTime, periodInMinutes? }; clear() resolves to wasCleared.
    const alarms = new Map();
    chrome.alarms = {
      onAlarm: makeEvent("alarms.onAlarm", record),
      create(...args) {
        const a = Array.from(args);
        const name = typeof a[0] === "string" ? a.shift() : "";
        return invoke("alarms.create", [name, ...a], (n, info = {}) => {
          const now = Date.now();
          const scheduledTime = info.when ?? now + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
          const alarm = { name: n, scheduledTime };
          if (info.periodInMinutes !== undefined) alarm.periodInMinutes = info.periodInMinutes;
          alarms.set(n, alarm);
          return undefined;
        });
      },
      get(...args) {
        const a = Array.from(args);
        if (typeof a[0] !== "string") a.unshift("");
        return invoke("alarms.get", a, (n) => clone(alarms.get(n)));
      },
      getAll: (...args) => invoke("alarms.getAll", args, () => clone([...alarms.values()])),
      clear(...args) {
        const a = Array.from(args);
        if (typeof a[0] !== "string") a.unshift("");
        return invoke("alarms.clear", a, (n) => alarms.delete(n));
      },
      clearAll: (...args) => invoke("alarms.clearAll", args, () => { const had = alarms.size > 0; alarms.clear(); return had; }),
    };
    function fireAlarm(name) {
      const alarm = alarms.get(name) || { name, scheduledTime: Date.now() };
      if (alarm.periodInMinutes === undefined) alarms.delete(name);
      chrome.alarms.onAlarm.dispatch(clone(alarm));
    }

    // ---- tabs ----
    // https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
    // get() of a missing id fails with "No tab with id: <id>."
    const tabs = (options.tabs || []).map((t, i) => ({ id: i + 1, index: i, windowId: 1, active: false, highlighted: false, pinned: false, incognito: false, ...t }));
    let tabsMessageHandler = null;
    const currentWindow = options.currentWindowId || 1;
    const matchUrl = (pattern, url) => {
      if (!url) return false;
      const re = new RegExp("^" + String(pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      return re.test(url);
    };
    chrome.tabs = {
      onUpdated: makeEvent("tabs.onUpdated", record),
      onActivated: makeEvent("tabs.onActivated", record),
      onRemoved: makeEvent("tabs.onRemoved", record),
      query: (...args) => invoke("tabs.query", args, (info = {}) => clone(tabs.filter((t) =>
        (info.active === undefined || t.active === info.active)
        && (info.currentWindow === undefined || (t.windowId === currentWindow) === info.currentWindow)
        && (info.windowId === undefined || t.windowId === info.windowId)
        && (info.url === undefined || [].concat(info.url).some((p) => matchUrl(p, t.url)))))),
      get: (...args) => invoke("tabs.get", args, (id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error("No tab with id: " + id + ".");
        return clone(tab);
      }),
      create: (...args) => invoke("tabs.create", args, (props = {}) => {
        const tab = { id: tabs.reduce((m, t) => Math.max(m, t.id), 0) + 1, index: tabs.length, windowId: props.windowId || currentWindow,
          active: props.active !== false, highlighted: false, pinned: !!props.pinned, incognito: false, url: props.url, pendingUrl: props.url };
        tabs.push(tab);
        return clone(tab);
      }),
      update: (...args) => invoke("tabs.update", args, (id, props = {}) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error("No tab with id: " + id + ".");
        Object.assign(tab, props);
        return clone(tab);
      }),
      remove: (...args) => invoke("tabs.remove", args, (ids) => {
        for (const id of [].concat(ids)) {
          const i = tabs.findIndex((t) => t.id === id);
          if (i < 0) throw new Error("No tab with id: " + id + ".");
          tabs.splice(i, 1);
        }
        return undefined;
      }),
      sendMessage: (...args) => invoke("tabs.sendMessage", args, async (id, message) => {
        if (!tabsMessageHandler) throw new Error("Could not establish connection. Receiving end does not exist.");
        return clone(await tabsMessageHandler(id, clone(message)));
      }),
    };

    // ---- permissions ----
    // https://developer.chrome.com/docs/extensions/reference/api/permissions
    // contains/request/remove take { permissions?, origins? } and resolve to a boolean.
    const granted = { permissions: new Set((options.permissions && options.permissions.permissions) || []), origins: new Set((options.permissions && options.permissions.origins) || []) };
    let requestAnswer = options.permissionRequestAnswer === true;
    const has = (p = {}) => (p.permissions || []).every((x) => granted.permissions.has(x)) && (p.origins || []).every((x) => granted.origins.has(x));
    chrome.permissions = {
      onAdded: makeEvent("permissions.onAdded", record),
      onRemoved: makeEvent("permissions.onRemoved", record),
      contains: (...args) => invoke("permissions.contains", args, (p) => has(p)),
      getAll: (...args) => invoke("permissions.getAll", args, () => ({ permissions: [...granted.permissions], origins: [...granted.origins] })),
      request: (...args) => invoke("permissions.request", args, (p = {}) => {
        if (has(p)) return true;
        if (!requestAnswer) return false;
        (p.permissions || []).forEach((x) => granted.permissions.add(x));
        (p.origins || []).forEach((x) => granted.origins.add(x));
        chrome.permissions.onAdded.dispatch(clone(p));
        return true;
      }),
      remove: (...args) => invoke("permissions.remove", args, (p = {}) => {
        const had = has(p);
        (p.permissions || []).forEach((x) => granted.permissions.delete(x));
        (p.origins || []).forEach((x) => granted.origins.delete(x));
        if (had) chrome.permissions.onRemoved.dispatch(clone(p));
        return had;
      }),
    };

    // ---- i18n ----
    // https://developer.chrome.com/docs/extensions/reference/api/i18n#method-getMessage
    // A messages.json table: { name: { message, placeholders? } }. Unknown name
    // gives "". $name$ is a placeholder (case-insensitive) whose content holds
    // $1..$9 for the substitutions; "$$" is a literal "$". At most 9 substitutions.
    // https://developer.chrome.com/docs/extensions/how-to/ui/localization-message-formats
    const messages = options.messages || {};
    chrome.i18n = {
      getMessage(name, substitutions) {
        record("i18n.getMessage", [name, substitutions]);
        const entry = messages[name];
        if (!entry || typeof entry.message !== "string") return "";
        const subs = substitutions === undefined ? [] : [].concat(substitutions).slice(0, 9).map(String);
        const fill = (text) => text.replace(/\$(\d)/g, (m, d) => (d === "0" ? m : subs[Number(d) - 1] ?? ""));
        const placeholders = {};
        for (const [k, v] of Object.entries(entry.placeholders || {})) placeholders[k.toLowerCase()] = v && v.content !== undefined ? String(v.content) : "";
        return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (m, key) => {
          if (m === "$$") return "$";
          const content = placeholders[key.toLowerCase()];
          return content === undefined ? m : fill(content);
        });
      },
      getUILanguage() { return options.uiLanguage || "en"; },
      getAcceptLanguages: (...args) => invoke("i18n.getAcceptLanguages", args, () => [options.uiLanguage || "en"]),
    };

    chrome.runtime = runtime;

    return {
      chrome,
      calls,
      unchecked, // lastError messages a callback never read
      callsOf: (api) => calls.filter((c) => c.api === api),
      // failure: "message" | { message } | { quota: true | "message" }; count: how many calls
      failNext(api, failure, count = 1) {
        const list = failures.get(api) || [];
        for (let i = 0; i < count; i++) list.push(failure);
        failures.set(api, list);
      },
      onSendMessage(fn) { sendHandler = fn; },
      onTabsSendMessage(fn) { tabsMessageHandler = fn; },
      dispatchMessage,
      fireAlarm,
      setPermissionRequestAnswer(v) { requestAnswer = v === true; },
      storageData: (area) => Object.fromEntries([...stores[area]].map(([k, v]) => [k, clone(v)])),
      tabs,
    };
  }

  function install(options) {
    const mock = create(options);
    globalThis.chrome = mock.chrome;
    return mock;
  }

  globalThis.pbpChromeMock = { create, install };
})();
