// ============================================================
// Pinboard Bookmark Enhanced -- WebDAV settings backup (batch (5))
// Top section is PURE: no DOM / chrome / fetch. Loaded by options.html,
// background.js (importScripts), and tests/webdav-tests.html (file://).
// Depends only on shared.js globals: SETTINGS_DEFAULTS, API_KEY_FIELDS,
// pbpStripExportTargetTokens, getSettingsStorage, pbpApplySecretOverlay,
// deobfuscateKey, deobfuscateSettings (the last four are only used by the
// chrome layer further down, added in a later task).
// ============================================================

const PBP_WEBDAV_FILENAME = "pinboard-bookmark-enhanced-settings.json";
const PBP_WEBDAV_WRITE_TEST_PREFIX = "pinboard-bookmark-enhanced-write-test-";
const PBP_WEBDAV_APP_COLLECTION = "pinboard-bookmark-enhanced";

// Appends the fixed backup filename to a user-supplied collection URL,
// handling a missing/present trailing slash. Degrades to "" on empty input
// (never throws) -- callers treat "" as "not configured".
function pbpWebdavFileUrl(baseUrl) {
  const base = pbpWebdavTargetCollectionUrl(baseUrl);
  return base ? base + PBP_WEBDAV_FILENAME : "";
}

function pbpWebdavCollectionUrl(baseUrl) {
  const raw = String(baseUrl == null ? "" : baseUrl).trim();
  if (!raw) return "";
  return raw.endsWith("/") ? raw : raw + "/";
}

function pbpWebdavCollectionFileUrl(baseUrl, name) {
  const base = pbpWebdavTargetCollectionUrl(baseUrl);
  return base ? base + encodeURIComponent(String(name || "")) : "";
}

function pbpWebdavTargetCollectionUrl(baseUrl) {
  const base = pbpWebdavCollectionUrl(baseUrl);
  if (!base) return "";
  try {
    const u = new URL(base);
    if (u.hostname === "dav.jianguoyun.com" && u.pathname.replace(/\/+$/, "") === "/dav") {
      return base + PBP_WEBDAV_APP_COLLECTION + "/";
    }
  } catch (_) {}
  return base;
}

// Basic auth header value, or null when there is nothing to authenticate
// with (both user and pass empty -- an anonymous WebDAV share). A password-
// less username (or user-less password) still produces a header: some
// WebDAV servers accept an empty-password Basic credential.
function pbpWebdavAuthHeader(user, pass) {
  const u = String(user == null ? "" : user);
  const p = String(pass == null ? "" : pass);
  if (!u && !p) return null;
  try {
    return "Basic " + btoa(unescape(encodeURIComponent(u + ":" + p)));
  } catch (_) {
    return null;
  }
}

// Derives a secure chrome.permissions origin pattern via shared.js.
function pbpWebdavOrigin(baseUrl) {
  return pbpEndpointOriginPattern(baseUrl);
}

// Whitelist-builds the push payload: every SETTINGS_DEFAULTS key EXCEPT the
// API_KEY_FIELDS, belt-stripped of exportTargets tokens, wrapped in a
// schema/meta envelope. Pure: meta.pushedAt/appVersion are supplied by the
// caller -- this function never touches Date.now() or chrome.runtime, so the
// exact same input always produces the exact same output (verified by the
// "no internal clock" test).
function pbpWebdavBuildPayload(settings, meta, extra) {
  meta = meta || {};
  extra = extra || {};
  const s = settings || {};
  const whitelist = Object.keys(SETTINGS_DEFAULTS).filter((k) => !API_KEY_FIELDS.includes(k));
  const payload = {};
  whitelist.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(s, k)) payload[k] = s[k];
  });
  if (payload.exportTargets) payload.exportTargets = pbpStripExportTargetTokens(payload.exportTargets);
  if (s.backupIncludeHighlights !== false && extra.highlights) payload._highlights = extra.highlights;
  payload._schemaVersion = 2;
  payload._webdav = { pushedAt: meta.pushedAt, appVersion: meta.appVersion };
  return payload;
}

// Builds a {url, method, headers} request descriptor for WebDAV actions.
// push=PUT file, pull/test=GET file, probe=PROPFIND collection.
function pbpWebdavBuildRequest(kind, cfg) {
  cfg = cfg || {};
  const url = (kind === "probe" || kind === "mkdir")
    ? pbpWebdavTargetCollectionUrl(cfg.baseUrl)
    : (/^write-test/.test(kind) ? pbpWebdavCollectionFileUrl(cfg.baseUrl, cfg.probeName) : pbpWebdavFileUrl(cfg.baseUrl));
  const headers = {};
  const auth = pbpWebdavAuthHeader(cfg.user, cfg.pass);
  if (auth) headers["Authorization"] = auth;
  if (kind === "probe") {
    headers.Depth = "0";
    return { url, method: "PROPFIND", headers };
  }
  if (kind === "write-test") {
    headers["Content-Type"] = "text/plain";
    headers["If-None-Match"] = "*";
    return { url, method: "PUT", headers };
  }
  if (kind === "write-test-delete") return { url, method: "DELETE", headers };
  if (kind === "mkdir") return { url, method: "MKCOL", headers };
  if (kind === "push") {
    headers["Content-Type"] = "application/json";
    return { url, method: "PUT", headers };
  }
  return { url, method: "GET", headers }; // "pull" | "test"
}

function _pbpWebdavFetch(kind, cfg, extra) {
  if (!pbpWebdavOrigin(cfg && cfg.baseUrl)) return Promise.reject(new Error("insecure"));
  const req = pbpWebdavBuildRequest(kind, cfg);
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(extra || {}),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
}

async function pbpWebdavEnsureCollection(cfg) {
  if (!pbpWebdavOrigin(cfg && cfg.baseUrl)) return { ok: false, error: "insecure" };
  const dir = await _pbpWebdavFetch("probe", cfg);
  if (dir.ok) return { ok: true };
  if (dir.status === 401 || dir.status === 403) return { ok: false, error: "auth" };
  if (dir.status !== 404) return { ok: false, error: "unreachable" };
  const made = await _pbpWebdavFetch("mkdir", cfg);
  if (made.ok || made.status === 405) return { ok: true };
  if (made.status === 401 || made.status === 403) return { ok: false, error: "auth" };
  return { ok: false, error: "not-found" };
}

async function pbpWebdavProbeWritable(cfg) {
  if (!pbpWebdavOrigin(cfg && cfg.baseUrl)) return { ok: false, error: "insecure" };
  const ensured = await pbpWebdavEnsureCollection(cfg);
  if (!ensured.ok) return ensured;
  const name = PBP_WEBDAV_WRITE_TEST_PREFIX + Date.now().toString(36) + ".txt";
  const probeCfg = Object.assign({}, cfg, { probeName: name });
  const resp = await _pbpWebdavFetch("write-test", probeCfg, { body: "ok" });
  if (resp.status === 401 || resp.status === 403) return { ok: false, error: "auth", status: resp.status };
  if (!resp.ok) return { ok: false, error: "not-writable", status: resp.status };
  try { await _pbpWebdavFetch("write-test-delete", probeCfg); } catch (_) {}
  return { ok: true };
}

// ============================================================
// Chrome layer (fetch + chrome.storage + chrome.permissions). NOT pure --
// not file:// loadable. Shared unmodified between background.js's
// "webdav-push" alarm handler (contains() ONLY, never request()) and
// options.js's Test/Push now/Pull now buttons (which request() inside the
// click gesture, then call these -- by then contains() is already true).
// ============================================================

// Storage-sourced cfg (used by the alarm, and as the default when a caller
// doesn't hand in a live-DOM override). webdavPass is deobfuscated here so
// callers never see the obf: wrapper.
async function _pbpWebdavCfg() {
  const storage = await getSettingsStorage();
  let s = await storage.get({ webdavUrl: "", webdavUser: "", webdavPass: "" });
  s = await pbpApplySecretOverlay(s); // MUST run before deobfuscateKey (shared.js convention)
  return { baseUrl: s.webdavUrl || "", user: s.webdavUser || "", pass: deobfuscateKey(s.webdavPass || "") };
}

// Test button / Push now / Pull now in options.js pass a cfgOverride built
// straight from the live form fields, so a click right after typing never
// races the 500ms debounced auto-save (same reasoning as options-connectivity
// .js's testAIProvider, which reads DOM values rather than storage).

async function pbpWebdavPush(cfgOverride) {
  const cfg = cfgOverride || await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, error: "no-url" };
  const origin = pbpWebdavOrigin(cfg.baseUrl);
  if (!origin) {
    const result = { ts: Date.now(), ok: false, error: "insecure" };
    try { await chrome.storage.local.set({ webdavLastPush: result }); } catch (_) {}
    return result;
  }
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const result = { ts: Date.now(), ok: false, error: "perm" };
      await chrome.storage.local.set({ webdavLastPush: result }).catch(() => {});
      return result;
    }
  } catch (_) {
    const result = { ts: Date.now(), ok: false, error: "perm" };
    await chrome.storage.local.set({ webdavLastPush: result }).catch(() => {});
    return result;
  }
  try {
    const ensured = await pbpWebdavEnsureCollection(cfg);
    if (!ensured.ok) {
      const result = { ts: Date.now(), ok: false, error: ensured.error };
      await chrome.storage.local.set({ webdavLastPush: result });
      return result;
    }
    const storage = await getSettingsStorage();
    let settings = await storage.get(SETTINGS_DEFAULTS);
    settings = await pbpApplySecretOverlay(settings);
    deobfuscateSettings(settings);
    if (Object.prototype.hasOwnProperty.call(cfg, "includeHighlights")) {
      settings.backupIncludeHighlights = cfg.includeHighlights !== false;
    }
    const meta = { pushedAt: new Date().toISOString(), appVersion: chrome.runtime.getManifest().version };
    let highlights = null;
    if (settings.backupIncludeHighlights !== false) {
      try { highlights = pbpBuildHighlightBackup(await chrome.storage.local.get(null)); } catch (_) {}
    }
    const payload = pbpWebdavBuildPayload(settings, meta, { highlights });
    const resp = await _pbpWebdavFetch("push", cfg, { body: JSON.stringify(payload) });
    let error = resp.ok ? undefined : ("http-" + resp.status);
    const status = resp.ok ? undefined : resp.status;
    if (resp.status === 404) {
      error = "not-found";
      try {
        const dir = await _pbpWebdavFetch("probe", cfg);
        if (dir.ok) error = "not-writable";
      } catch (_) {}
    }
    const result = { ts: Date.now(), ok: resp.ok, error, status };
    await chrome.storage.local.set({ webdavLastPush: result });
    return result;
  } catch (e) {
    const result = { ts: Date.now(), ok: false, error: (e && e.message) || "network" };
    await chrome.storage.local.set({ webdavLastPush: result }).catch(() => {});
    return result;
  }
}

async function pbpWebdavPull(cfgOverride) {
  const cfg = cfgOverride || await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, error: "no-url" };
  const origin = pbpWebdavOrigin(cfg.baseUrl);
  if (!origin) return { ok: false, error: "insecure" };
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, error: "perm" };
  } catch (_) { return { ok: false, error: "perm" }; }
  try {
    const resp = await _pbpWebdavFetch("pull", cfg);
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "auth" };
    if (resp.status === 404) return { ok: false, error: "not-found" };
    if (!resp.ok) return { ok: false, error: "http-" + resp.status };
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== "object" || !data._schemaVersion) return { ok: false, error: "invalid" };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network" };
  }
}

async function pbpWebdavTest(cfgOverride) {
  const cfg = cfgOverride || await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, kind: "no-url" };
  const origin = pbpWebdavOrigin(cfg.baseUrl);
  if (!origin) return { ok: false, kind: "insecure" };
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, kind: "perm" };
  } catch (_) { return { ok: false, kind: "perm" }; }
  try {
    const resp = await _pbpWebdavFetch("test", cfg);
    if (resp.status === 401 || resp.status === 403) return { ok: false, kind: "auth" };
    if (resp.status === 404) {
      const writable = await pbpWebdavProbeWritable(cfg);
      return writable.ok ? { ok: true, kind: "empty" } : { ok: false, kind: writable.error, status: writable.status };
    }
    if (resp.ok) {
      const writable = await pbpWebdavProbeWritable(cfg);
      return writable.ok ? { ok: true, kind: "found" } : { ok: false, kind: writable.error, status: writable.status };
    }
    return { ok: false, kind: "unreachable" };
  } catch (_) {
    return { ok: false, kind: "unreachable" };
  }
}
