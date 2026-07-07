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

// Appends the fixed backup filename to a user-supplied collection URL,
// handling a missing/present trailing slash. Degrades to "" on empty input
// (never throws) -- callers treat "" as "not configured".
function pbpWebdavFileUrl(baseUrl) {
  const raw = String(baseUrl == null ? "" : baseUrl).trim();
  if (!raw) return "";
  return (raw.endsWith("/") ? raw : raw + "/") + PBP_WEBDAV_FILENAME;
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

// Derives a chrome.permissions origin pattern ("<scheme>://<host>[:port]/*")
// from the user's WebDAV URL. Mirrors export-targets.js's webhook.origin(cfg).
function pbpWebdavOrigin(baseUrl) {
  try { return new URL(String(baseUrl || "")).origin + "/*"; } catch (_) { return null; }
}

// Whitelist-builds the push payload: every SETTINGS_DEFAULTS key EXCEPT the
// API_KEY_FIELDS, belt-stripped of exportTargets tokens, wrapped in a
// schema/meta envelope. Pure: meta.pushedAt/appVersion are supplied by the
// caller -- this function never touches Date.now() or chrome.runtime, so the
// exact same input always produces the exact same output (verified by the
// "no internal clock" test).
function pbpWebdavBuildPayload(settings, meta) {
  meta = meta || {};
  const s = settings || {};
  const whitelist = Object.keys(SETTINGS_DEFAULTS).filter((k) => !API_KEY_FIELDS.includes(k));
  const payload = {};
  whitelist.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(s, k)) payload[k] = s[k];
  });
  if (payload.exportTargets) payload.exportTargets = pbpStripExportTargetTokens(payload.exportTargets);
  payload._schemaVersion = 2;
  payload._webdav = { pushedAt: meta.pushedAt, appVersion: meta.appVersion };
  return payload;
}

// Builds a {url, method, headers} request descriptor for one of the three
// WebDAV actions. push=PUT (writes the file), pull/test=GET (reads it).
function pbpWebdavBuildRequest(kind, cfg) {
  cfg = cfg || {};
  const url = pbpWebdavFileUrl(cfg.baseUrl);
  const headers = {};
  const auth = pbpWebdavAuthHeader(cfg.user, cfg.pass);
  if (auth) headers["Authorization"] = auth;
  if (kind === "push") {
    headers["Content-Type"] = "application/json";
    return { url, method: "PUT", headers };
  }
  return { url, method: "GET", headers }; // "pull" | "test"
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
  if (!origin) return { ok: false, error: "no-url" };
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
    const storage = await getSettingsStorage();
    let settings = await storage.get(SETTINGS_DEFAULTS);
    settings = await pbpApplySecretOverlay(settings);
    deobfuscateSettings(settings);
    const meta = { pushedAt: new Date().toISOString(), appVersion: chrome.runtime.getManifest().version };
    const payload = pbpWebdavBuildPayload(settings, meta);
    const req = pbpWebdavBuildRequest("push", cfg);
    const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const result = { ts: Date.now(), ok: resp.ok, error: resp.ok ? undefined : ("http-" + resp.status) };
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
  if (!origin) return { ok: false, error: "no-url" };
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, error: "perm" };
  } catch (_) { return { ok: false, error: "perm" }; }
  try {
    const req = pbpWebdavBuildRequest("pull", cfg);
    const resp = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(20000) });
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
  if (!origin) return { ok: false, kind: "unreachable" };
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, kind: "perm" };
  } catch (_) { return { ok: false, kind: "perm" }; }
  try {
    const req = pbpWebdavBuildRequest("test", cfg);
    const resp = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(20000) });
    if (resp.status === 401 || resp.status === 403) return { ok: false, kind: "auth" };
    if (resp.status === 404) return { ok: true, kind: "empty" };
    if (resp.ok) return { ok: true, kind: "found" };
    return { ok: false, kind: "unreachable" };
  } catch (_) {
    return { ok: false, kind: "unreachable" };
  }
}
