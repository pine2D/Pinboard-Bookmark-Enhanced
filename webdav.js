// ============================================================
// Pinboard Bookmark Enhanced -- WebDAV settings backup (batch (5))
// Top section is PURE: no DOM / chrome / fetch. Loaded by options.html,
// background.js (importScripts), and tests/webdav-tests.html (file://).
// Depends only on shared.js globals for settings/secret routing, backup
// validation, endpoint checks, and deobfuscation.
// ============================================================

const PBP_WEBDAV_FILENAME = "pinboard-bookmark-enhanced-settings.json";
const PBP_WEBDAV_WRITE_TEST_PREFIX = "pinboard-bookmark-enhanced-write-test-";
const PBP_WEBDAV_APP_COLLECTION = "pinboard-bookmark-enhanced";
const PBP_WEBDAV_ETAG_STATE_KEY = "_webdavEtagState";

// Appends the fixed backup filename to a user-supplied collection URL,
// handling a missing/present trailing slash. Degrades to "" on empty input
// (never throws) -- callers treat "" as "not configured".
function pbpWebdavFileUrl(baseUrl) {
  return pbpWebdavCollectionFileUrl(baseUrl, PBP_WEBDAV_FILENAME);
}

function pbpWebdavCollectionUrl(baseUrl) {
  const raw = String(baseUrl == null ? "" : baseUrl).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    // Fragments never reach a WebDAV server and would make the configured
    // target differ from the actual request. Query capability tokens are
    // preserved, but path components are always appended through URL().
    if (url.hash) return "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch (_) { return ""; }
}

function pbpWebdavCollectionFileUrl(baseUrl, name) {
  const base = pbpWebdavTargetCollectionUrl(baseUrl);
  if (!base) return "";
  try {
    const url = new URL(base);
    url.pathname += encodeURIComponent(String(name || ""));
    return url.href;
  } catch (_) { return ""; }
}

function pbpWebdavTargetCollectionUrl(baseUrl) {
  const base = pbpWebdavCollectionUrl(baseUrl);
  if (!base) return "";
  try {
    const u = new URL(base);
    if (u.hostname === "dav.jianguoyun.com" && u.pathname.replace(/\/+$/, "") === "/dav") {
      u.pathname += PBP_WEBDAV_APP_COLLECTION + "/";
      return u.href;
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
  return pbpWebdavTargetCollectionUrl(baseUrl) ? pbpEndpointOriginPattern(baseUrl) : null;
}

function pbpWebdavValidEtag(value) {
  // If-Match uses strong comparison. Only accept a syntactically valid strong
  // entity-tag; weak validators and wildcard/garbage values must never be
  // echoed back as though they identify one exact remote revision.
  return typeof value === "string" && /^"[\x21\x23-\x7E\x80-\xFF]*"$/.test(value.trim());
}

function pbpWebdavResponseEtag(response) {
  try {
    const value = response && response.headers && response.headers.get("ETag");
    return pbpWebdavValidEtag(value) ? value.trim() : "";
  } catch (_) { return ""; }
}

function pbpWebdavEtagStateMatchesTarget(state, target, user) {
  if (!state || typeof state.target !== "string") return false;
  // Accept the short-lived plaintext shape from pre-fix builds, but every new
  // write below stores the capability URL through the normal obf: wrapper.
  // The Basic-auth username is part of the remote resource identity: the same
  // URL can expose a different DAV tree for each account. Legacy state without
  // a user is accepted only for anonymous configurations.
  return deobfuscateKey(state.target) === target &&
    deobfuscateKey(state.user || "") === String(user || "");
}

function pbpWebdavAutoPushPeriod(settings) {
  const s = settings || {};
  // deobfuscateKey passes plaintext through and heals values a transitional
  // build stored obf-wrapped. Half-configured Basic auth — either half alone
  // (username without password OR password without username) — never
  // schedules: every tick would 401 and rewrite webdavLastPush with the same
  // error forever. A fully anonymous config (no username, no password) is a
  // supported WebDAV share shape.
  const url = deobfuscateKey(s.webdavUrl || "");
  if (!url || !pbpWebdavOrigin(url)) return 0;
  if (!!s.webdavUser !== !!s.webdavPass) return 0;
  if (s.webdavAutoPush === "daily") return 1440;
  if (s.webdavAutoPush === "hourly") return 60;
  return 0;
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
  // customOverlayCSS + savedThemes are NOT SETTINGS_DEFAULTS keys (stored chunked
  // via syncSetLarge), so the whitelist above never picks them up. The caller reads
  // them and hands them in, mirroring options-backup.js's file export, so a WebDAV
  // restore carries the user's custom theme instead of silently dropping it.
  payload.customOverlayCSS = typeof extra.overlay === "string" ? extra.overlay : "";
  // No size gate on the overlay: a legacy oversize overlay is still the
  // user's data, and throwing here would silently kill every scheduled push.
  // Keep generated backups self-importable: reject structurally corrupt theme
  // entries before replacing a valid remote backup (size is NOT asserted —
  // the import side re-chunks through syncSetLarge, local fallback on quota).
  payload.savedThemes = pbpSanitizeBackupThemes(
    Array.isArray(extra.savedThemes) ? extra.savedThemes : [],
  );
  if (s.backupIncludeHighlights !== false && extra.highlights) {
    payload._highlights = extra.highlights;
    // Non-secret owner (Pinboard username) so a restore onto a different account
    // can refuse to merge this account's reading notes. See pbpHighlightBackupOwnerAllowed.
    if (extra.highlightsOwner) payload._highlightsOwner = extra.highlightsOwner;
  }
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
    if (pbpWebdavValidEtag(cfg.etag)) headers["If-Match"] = cfg.etag.trim();
    else if (cfg.known === true) headers["If-Match"] = "*";
    else if (cfg.createOnly === true) headers["If-None-Match"] = "*";
    // Unknown revision withOUT createOnly (a USER-GESTURE push): plain
    // unconditional PUT, matching the pre-CAS releases — the click is the
    // overwrite intent, and If-None-Match:* would 412 forever against an
    // existing remote file with a destructive Pull as the only unlock.
    // Scheduled pushes pass createOnly so automation can never blind-
    // overwrite a backup this device has never seen (see pbpWebdavPush).
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
    cache: "no-store",
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
// doesn't hand in a live-DOM override). The password is credential-routed and
// obfuscated at rest; URL/username are ordinary settings stored in plaintext
// (deobfuscateKey passes them through, healing transitional obf-wrapped values).
async function _pbpWebdavCfg() {
  const s = await pbpReadSettingsWithSecrets({ webdavUrl: "", webdavUser: "", webdavPass: "" });
  return {
    baseUrl: deobfuscateKey(s.webdavUrl || ""),
    user: deobfuscateKey(s.webdavUser || ""),
    pass: deobfuscateKey(s.webdavPass || ""),
  };
}

async function pbpWebdavReadRevision(cfg) {
  const target = pbpWebdavFileUrl(cfg && cfg.baseUrl);
  if (!target) return { known: false, etag: "" };
  try {
    const stored = await chrome.storage.local.get(PBP_WEBDAV_ETAG_STATE_KEY);
    const state = stored[PBP_WEBDAV_ETAG_STATE_KEY];
    if (!pbpWebdavEtagStateMatchesTarget(state, target, cfg && cfg.user)) return { known: false, etag: "" };
    return { known: true, etag: pbpWebdavValidEtag(state.etag) ? state.etag.trim() : "" };
  } catch (_) { return { known: false, etag: "" }; }
}

async function pbpWebdavClearEtag(cfg) {
  const target = pbpWebdavFileUrl(cfg && cfg.baseUrl);
  if (!target) return;
  try {
    const stored = await chrome.storage.local.get(PBP_WEBDAV_ETAG_STATE_KEY);
    if (pbpWebdavEtagStateMatchesTarget(stored[PBP_WEBDAV_ETAG_STATE_KEY], target, cfg && cfg.user)) {
      await chrome.storage.local.remove(PBP_WEBDAV_ETAG_STATE_KEY);
    }
  } catch (_) {}
}

async function pbpWebdavRememberEtag(cfg, etag) {
  const target = pbpWebdavFileUrl(cfg && cfg.baseUrl);
  if (!target) return false;
  const strongEtag = pbpWebdavValidEtag(etag) ? etag.trim() : "";
  await chrome.storage.local.set({
    // Target match means the remote file is known to exist even when this
    // WebDAV server does not expose a usable strong validator. That state uses
    // If-Match:* on the next write instead of getting stuck on create-only 412.
    [PBP_WEBDAV_ETAG_STATE_KEY]: {
      target: obfuscateKey(target),
      user: obfuscateKey(String(cfg && cfg.user || "")),
      etag: strongEtag,
    },
  });
  return !!strongEtag;
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
    const settings = await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS);
    deobfuscateSettings(settings);
    if (Object.prototype.hasOwnProperty.call(cfg, "includeHighlights")) {
      settings.backupIncludeHighlights = cfg.includeHighlights !== false;
    }
    const meta = { pushedAt: new Date().toISOString(), appVersion: chrome.runtime.getManifest().version };
    // customOverlayCSS + savedThemes live outside SETTINGS_DEFAULTS (chunked via
    // syncSetLarge), so read them explicitly and mirror options-backup.js's export
    // overlay source selection (sync large blob, or this device's local fallback).
    const local = await chrome.storage.local.get("customOverlayCSS_localFallback");
    const overlay = typeof local.customOverlayCSS_localFallback === "string"
      ? local.customOverlayCSS_localFallback
      : await syncGetLarge("customOverlayCSS", "");
    const savedThemes = await syncGetLarge("savedThemes", []);
    let highlights = null;
    if (settings.backupIncludeHighlights !== false) {
      highlights = pbpBuildHighlightBackup(await chrome.storage.local.get(null));
    }
    const owner = pbpPinboardAccountFromToken(settings.pinboardToken);
    const payload = pbpWebdavBuildPayload(settings, meta, { highlights, highlightsOwner: owner, overlay, savedThemes });
    const expectedRevision = await pbpWebdavReadRevision(cfg);
    const conditionalCfg = Object.assign({}, cfg, expectedRevision);
    // A SCHEDULED push with no known revision must never blind-overwrite: a
    // second device's alarm would silently clobber the first device's backup.
    // Unknown-revision alarm pushes are create-only; a 412 then either seeds
    // known-exists once for an upgrader that provably pushed from this device
    // before (webdavLastPush.ok from a pre-ETag build), or surfaces as a
    // conflict the user resolves with a manual push/pull. Manual pushes
    // (cfgOverride from the options buttons) keep the unconditional pre-CAS
    // behavior — the click is the overwrite intent.
    const isScheduled = !cfgOverride;
    if (isScheduled && expectedRevision.known !== true && !pbpWebdavValidEtag(expectedRevision.etag)) {
      conditionalCfg.createOnly = true;
    }
    let resp = await _pbpWebdavFetch("push", conditionalCfg, { body: JSON.stringify(payload) });
    if (resp.status === 412 && conditionalCfg.createOnly === true) {
      // Only a prior success against the SAME target+user may authorize the
      // one-time If-Match:* takeover: a success recorded at an old server
      // must not let the alarm blind-overwrite a NEW target's existing file.
      // Legacy records from pre-binding builds carry no target and get one
      // grace pass — the first success under this build rebinds them.
      let allowTakeover = false;
      try {
        const { webdavLastPush } = await chrome.storage.local.get("webdavLastPush");
        if (webdavLastPush && webdavLastPush.ok === true) {
          allowTakeover = !("target" in webdavLastPush) ||
            (deobfuscateKey(webdavLastPush.target || "") === pbpWebdavFileUrl(cfg.baseUrl) &&
             deobfuscateKey(webdavLastPush.user || "") === String(cfg.user || ""));
        }
      } catch (_) {}
      if (allowTakeover) {
        resp = await _pbpWebdavFetch("push",
          Object.assign({}, cfg, { known: true, etag: "" }),
          { body: JSON.stringify(payload) });
      }
    }
    if (resp.status === 412) {
      const result = { ts: Date.now(), ok: false, error: "conflict", status: 412 };
      await chrome.storage.local.set({ webdavLastPush: result });
      return result;
    }
    let error = resp.ok ? undefined : ("http-" + resp.status);
    const status = resp.ok ? undefined : resp.status;
    if (resp.status === 404) {
      error = "not-found";
      try {
        const dir = await _pbpWebdavFetch("probe", cfg);
        if (dir.ok) error = "not-writable";
      } catch (_) {}
    }
    const nextEtag = resp.ok ? pbpWebdavResponseEtag(resp) : "";
    // Do not GET after PUT to hunt for an ETag: another device could write in
    // that gap and we would incorrectly claim its revision. A missing/weak
    // validator is remembered as known-exists and degrades to If-Match:*.
    if (resp.ok) await pbpWebdavRememberEtag(cfg, nextEtag).catch(() => {});
    const result = { ts: Date.now(), ok: resp.ok, error, status, etag: nextEtag || undefined };
    if (resp.ok) {
      // Bind the success to its target (obfuscated like the ETag state) so a
      // later URL/username switch cannot inherit takeover authority from it.
      result.target = obfuscateKey(pbpWebdavFileUrl(cfg.baseUrl));
      result.user = obfuscateKey(String(cfg.user || ""));
    }
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
    if (resp.status === 404) {
      await pbpWebdavClearEtag(cfg);
      return { ok: false, error: "not-found" };
    }
    if (!resp.ok) return { ok: false, error: "http-" + resp.status };
    const data = await resp.json().catch(() => null);
    try { pbpBackupSchemaVersion(data); }
    catch (_) { return { ok: false, error: "invalid" }; }
    return { ok: true, data, etag: pbpWebdavResponseEtag(resp) };
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
