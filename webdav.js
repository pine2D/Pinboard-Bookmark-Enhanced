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
