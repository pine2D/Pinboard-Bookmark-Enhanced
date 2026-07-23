// ============================================================
// Pinboard Bookmark Enhanced -- WebDAV settings backup (batch (5))
// Top section is PURE: no DOM / chrome / fetch. Loaded by options.html,
// background.js (importScripts), and tests/webdav-tests.html (file://).
// Depends only on shared.js globals for settings/secret routing, backup
// validation, endpoint checks, and deobfuscation.
// ============================================================

const PBP_WEBDAV_FILENAME = "pinboard-bookmark-enhanced-settings.json";
const PBP_WEBDAV_APP_COLLECTION = "pinboard-bookmark-enhanced";
const PBP_WEBDAV_LOCATOR_FILENAME = "location.json";
const PBP_WEBDAV_LAYOUT_VERSION = 2;
const PBP_WEBDAV_WRITE_TEST_PREFIX = "pinboard-bookmark-enhanced-write-test-";
const PBP_WEBDAV_SYNC_STATE_KEY = "_webdavSyncState";
const PBP_WEBDAV_AUTO_PUSH_KEY = "webdavAutoPush";
const PBP_WEBDAV_AUTO_PUSH_MIGRATION_KEY = "_webdavAutoPushLocalV1";

function pbpWebdavStableClone(value) {
  if (Array.isArray(value)) return value.map(pbpWebdavStableClone);
  if (!pbpIsPlainRecord(value)) return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    out[key] = pbpWebdavStableClone(value[key]);
  });
  return out;
}

function pbpWebdavStableStringify(value) {
  return JSON.stringify(pbpWebdavStableClone(value));
}

function pbpWebdavSemanticValue(payload) {
  if (!pbpIsPlainRecord(payload)) return {};
  const semantic = {};
  Object.keys(payload).forEach((key) => {
    if (key !== "_webdav") semantic[key] = payload[key];
  });
  return pbpWebdavStableClone(semantic);
}

function pbpWebdavDecide({ baselineHash, localHash, remoteHash, hasBaseline, remoteExists }) {
  if (!remoteExists) return hasBaseline ? "remote-changed" : "create";
  if (remoteHash === localHash) return "same";
  if (!hasBaseline) return "unpaired";
  if (remoteHash === baselineHash) return "push";
  if (localHash === baselineHash) return "remote-changed";
  return "diverged";
}

async function pbpWebdavSha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pbpWebdavTargetId(cfg) {
  const target = pbpWebdavFileUrl(cfg && cfg.baseUrl);
  if (!target) return "";
  return pbpWebdavSha256(target + "\n" + String(cfg && cfg.user || ""));
}

function pbpWebdavNormalizeRelativePath(value) {
  const raw = String(value == null ? "" : value).trim().replace(/\/+$/, "");
  if (!raw) return { ok: false, error: "empty" };
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("/")) {
    return { ok: false, error: "absolute" };
  }
  if (raw.includes("\\") || raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: "separator" };
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment)) return { ok: false, error: "segment" };
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch (_) { return { ok: false, error: "encoding" }; }
    if (!decoded || decoded === "." || decoded === ".." ||
        decoded.includes("/") || decoded.includes("\\")) {
      return { ok: false, error: "segment" };
    }
  }
  return {
    ok: true,
    value: segments.map((segment) => decodeURIComponent(segment)).join("/") + "/",
    encoded: segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/") + "/",
  };
}

function pbpWebdavEmptyState() {
  return {
    known: false,
    mode: "unknown",
    etag: "",
    remoteHash: "",
    settingsHash: "",
    lastSuccessAt: 0,
    unresolvedConflict: null,
  };
}

async function pbpWebdavReadState(cfg) {
  const targetId = await pbpWebdavTargetId(cfg);
  if (!targetId) return pbpWebdavEmptyState();
  try {
    const stored = await chrome.storage.local.get(PBP_WEBDAV_SYNC_STATE_KEY);
    const state = stored[PBP_WEBDAV_SYNC_STATE_KEY];
    if (!pbpIsPlainRecord(state) || state.targetId !== targetId) return pbpWebdavEmptyState();
    return {
      known: !!state.settingsHash,
      mode: ["unknown", "etag", "hash"].includes(state.mode) ? state.mode : "unknown",
      etag: pbpWebdavValidEtag(state.etag) ? state.etag.trim() : "",
      remoteHash: typeof state.remoteHash === "string" ? state.remoteHash : "",
      settingsHash: typeof state.settingsHash === "string" ? state.settingsHash : "",
      lastSuccessAt: Number.isFinite(state.lastSuccessAt) ? state.lastSuccessAt : 0,
      unresolvedConflict: pbpIsPlainRecord(state.unresolvedConflict) ? state.unresolvedConflict : null,
    };
  } catch (_) {
    return pbpWebdavEmptyState();
  }
}

async function pbpWebdavRememberState(cfg, next) {
  const targetId = await pbpWebdavTargetId(cfg);
  if (!targetId) return false;
  const state = Object.assign(pbpWebdavEmptyState(), next || {});
  delete state.known;
  state.targetId = targetId;
  await chrome.storage.local.set({ [PBP_WEBDAV_SYNC_STATE_KEY]: state });
  return true;
}

async function pbpWebdavReadRemote(cfg) {
  try {
    const resp = await _pbpWebdavFetch("pull", cfg, pbpWebdavFileUrl(cfg && cfg.baseUrl));
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "auth", status: resp.status };
    if (resp.status === 404) return { ok: true, exists: false, etag: "", remoteHash: "", settingsHash: "" };
    if (!resp.ok) return { ok: false, error: "http-" + resp.status, status: resp.status };
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
      pbpBackupSchemaVersion(data);
    } catch (_) {
      return { ok: false, error: "invalid" };
    }
    return {
      ok: true,
      exists: true,
      text,
      data,
      etag: pbpWebdavResponseEtag(resp),
      remoteHash: await pbpWebdavSha256(text),
      settingsHash: await pbpWebdavSha256(pbpWebdavStableStringify(pbpWebdavSemanticValue(data))),
    };
  } catch (error) {
    return { ok: false, error: (error && error.message) || "network" };
  }
}

async function pbpWebdavDecisionResult(cfg, state, remote, decision) {
  if (["remote-changed", "diverged", "unpaired"].includes(decision)) {
    await pbpWebdavRememberState(cfg, Object.assign({}, state, {
      unresolvedConflict: {
        kind: decision,
        remoteHash: remote && remote.remoteHash || "",
        settingsHash: remote && remote.settingsHash || "",
        detectedAt: Date.now(),
      },
    })).catch(() => {});
  }
  return {
    ok: false,
    error: decision === "diverged" ? "diverged"
      : decision === "unpaired" ? "unpaired"
        : "remote-changed",
  };
}

async function pbpWebdavAdoptRemote(cfg, remote, preferredMode) {
  const mode = preferredMode === "hash" || !remote.etag ? "hash" : "etag";
  await pbpWebdavRememberState(cfg, {
    mode,
    etag: remote.etag || "",
    remoteHash: remote.remoteHash,
    settingsHash: remote.settingsHash,
    lastSuccessAt: Date.now(),
    unresolvedConflict: null,
  });
  return {
    ok: true,
    noop: true,
    ts: Date.now(),
    mode,
    etag: remote.etag || undefined,
    remoteHash: remote.remoteHash,
    settingsHash: remote.settingsHash,
  };
}

async function pbpWebdavUploadText(cfg, text, options) {
  options = options || {};
  let payload;
  try {
    payload = JSON.parse(text);
    pbpBackupSchemaVersion(payload);
  } catch (_) {
    return { ok: false, error: "invalid" };
  }
  const localHash = await pbpWebdavSha256(
    pbpWebdavStableStringify(pbpWebdavSemanticValue(payload)));
  const uploadedHash = await pbpWebdavSha256(text);
  const state = await pbpWebdavReadState(cfg);
  let remote = await pbpWebdavReadRemote(cfg);
  if (!remote.ok) return remote;

  let decision = pbpWebdavDecide({
    baselineHash: state.settingsHash,
    localHash,
    remoteHash: remote.settingsHash,
    hasBaseline: state.known,
    remoteExists: remote.exists,
  });
  if (decision === "same") return pbpWebdavAdoptRemote(cfg, remote, state.mode);
  if (!options.force && decision !== "push" && decision !== "create") {
    return pbpWebdavDecisionResult(cfg, state, remote, decision);
  }

  let mode = state.mode === "hash" ? "hash" : "etag";
  let pushCfg = Object.assign({}, cfg);
  if (!options.force && decision === "create") {
    pushCfg.createOnly = true;
  } else if (!options.force && state.mode !== "hash" && remote.etag) {
    pushCfg.etag = remote.etag;
    mode = "etag";
  } else if (!options.force) {
    mode = "hash";
  }

  let resp = await _pbpWebdavFetch("push", pushCfg, pbpWebdavFileUrl(pushCfg.baseUrl), { body: text });
  if (resp.status === 412) {
    remote = await pbpWebdavReadRemote(cfg);
    if (!remote.ok) return remote;
    decision = pbpWebdavDecide({
      baselineHash: state.settingsHash,
      localHash,
      remoteHash: remote.settingsHash,
      hasBaseline: state.known,
      remoteExists: remote.exists,
    });
    if (decision === "same") return pbpWebdavAdoptRemote(cfg, remote, state.mode);
    if (decision !== "push" || options.force) {
      return pbpWebdavDecisionResult(cfg, state, remote, decision);
    }

    if (!remote.etag) {
      mode = "hash";
      resp = await _pbpWebdavFetch("push", cfg, pbpWebdavFileUrl(cfg.baseUrl), { body: text });
    } else {
      const retryCfg = Object.assign({}, cfg, { etag: remote.etag });
      resp = await _pbpWebdavFetch("push", retryCfg, pbpWebdavFileUrl(retryCfg.baseUrl), { body: text });
      if (resp.status === 412) {
        remote = await pbpWebdavReadRemote(cfg);
        if (!remote.ok) return remote;
        decision = pbpWebdavDecide({
          baselineHash: state.settingsHash,
          localHash,
          remoteHash: remote.settingsHash,
          hasBaseline: state.known,
          remoteExists: remote.exists,
        });
        if (decision === "same") return pbpWebdavAdoptRemote(cfg, remote, state.mode);
        if (decision !== "push") return pbpWebdavDecisionResult(cfg, state, remote, decision);
        mode = "hash";
        resp = await _pbpWebdavFetch("push", cfg, pbpWebdavFileUrl(cfg.baseUrl), { body: text });
      } else {
        mode = "etag";
      }
    }
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: "auth", status: resp.status };
    }
    return { ok: false, error: "http-" + resp.status, status: resp.status };
  }

  const verified = await pbpWebdavReadRemote(cfg);
  if (!verified.ok || !verified.exists || verified.remoteHash !== uploadedHash) {
    return {
      ok: false,
      error: "verify-failed",
      cause: verified.ok ? "content-mismatch" : verified.error,
    };
  }
  if (mode !== "hash") mode = verified.etag ? "etag" : "hash";
  await pbpWebdavRememberState(cfg, {
    mode,
    etag: verified.etag || "",
    remoteHash: verified.remoteHash,
    settingsHash: verified.settingsHash,
    lastSuccessAt: Date.now(),
    unresolvedConflict: null,
  });
  return {
    ok: true,
    ts: Date.now(),
    mode,
    etag: verified.etag || undefined,
    remoteHash: verified.remoteHash,
    settingsHash: verified.settingsHash,
  };
}

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
  return pbpWebdavCollectionUrl(baseUrl);
}

function pbpWebdavAppendRelativeCollection(baseUrl, encodedPath) {
  const base = pbpWebdavCollectionUrl(baseUrl);
  if (!base) return "";
  const url = new URL(base);
  url.pathname += encodedPath;
  return url.href;
}

function pbpWebdavResolveTarget(cfg) {
  cfg = cfg || {};
  const baseCollectionUrl = pbpWebdavCollectionUrl(cfg.baseUrl);
  if (!baseCollectionUrl || !pbpWebdavOrigin(baseCollectionUrl)) {
    return { ok: false, error: "base-url" };
  }

  let folderMode = cfg.folderMode === "custom" ? "custom" : "managed";
  const path = folderMode === "custom"
    ? pbpWebdavNormalizeRelativePath(cfg.relativePath)
    : pbpWebdavNormalizeRelativePath(PBP_WEBDAV_APP_COLLECTION);
  if (!path.ok) return { ok: false, error: "relative-path", pathError: path.error };
  if (path.value === PBP_WEBDAV_APP_COLLECTION + "/") folderMode = "managed";

  const appPath = PBP_WEBDAV_APP_COLLECTION + "/";
  const locatorCollectionUrl = pbpWebdavAppendRelativeCollection(baseCollectionUrl, appPath);
  const backupCollectionUrl = pbpWebdavAppendRelativeCollection(baseCollectionUrl, path.encoded);
  const backupFileUrl = pbpWebdavCollectionFileUrl(backupCollectionUrl, PBP_WEBDAV_FILENAME);
  return {
    ok: true,
    folderMode,
    relativePath: path.value,
    encodedRelativePath: path.encoded,
    baseCollectionUrl,
    locatorCollectionUrl,
    locatorFileUrl: pbpWebdavCollectionFileUrl(locatorCollectionUrl, PBP_WEBDAV_LOCATOR_FILENAME),
    backupCollectionUrl,
    backupFileUrl,
  };
}

async function pbpWebdavFreezeTarget(cfg) {
  const target = pbpWebdavResolveTarget(cfg);
  if (!target.ok) return target;
  return Object.assign(target, {
    targetId: await pbpWebdavSha256(
      target.backupFileUrl + "\n" + String(cfg && cfg.user || "")
    ),
    user: String(cfg && cfg.user || ""),
  });
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

function pbpWebdavNormalizeAutoPush(value) {
  return value === "hourly" || value === "daily" ? value : "off";
}

async function pbpWebdavWriteAutoPush(value) {
  const normalized = pbpWebdavNormalizeAutoPush(value);
  await chrome.storage.local.set({
    [PBP_WEBDAV_AUTO_PUSH_KEY]: normalized,
    [PBP_WEBDAV_AUTO_PUSH_MIGRATION_KEY]: true,
  });
  return normalized;
}

async function pbpWebdavReadAutoPush(cfg) {
  let local;
  try {
    local = await chrome.storage.local.get([
      PBP_WEBDAV_AUTO_PUSH_KEY,
      PBP_WEBDAV_AUTO_PUSH_MIGRATION_KEY,
      PBP_WEBDAV_SYNC_STATE_KEY,
      "_webdavEtagState",
      "webdavLastPush",
    ]);
  } catch (_) {
    return "off";
  }
  if (Object.prototype.hasOwnProperty.call(local, PBP_WEBDAV_AUTO_PUSH_KEY)) {
    const value = pbpWebdavNormalizeAutoPush(local[PBP_WEBDAV_AUTO_PUSH_KEY]);
    if (local[PBP_WEBDAV_AUTO_PUSH_KEY] !== value ||
        !local[PBP_WEBDAV_AUTO_PUSH_MIGRATION_KEY]) await pbpWebdavWriteAutoPush(value);
    return value;
  }
  if (local[PBP_WEBDAV_AUTO_PUSH_MIGRATION_KEY]) return "off";

  const target = pbpWebdavFileUrl(cfg && cfg.baseUrl);
  const user = String(cfg && cfg.user || "");
  const targetId = target ? await pbpWebdavTargetId(cfg) : "";
  const state = local[PBP_WEBDAV_SYNC_STATE_KEY];
  const legacyState = local._webdavEtagState;
  const last = local.webdavLastPush;
  const matchingState = !!(targetId && pbpIsPlainRecord(state) &&
    state.targetId === targetId && state.settingsHash);
  const matchingLegacyState = !!(target && pbpIsPlainRecord(legacyState) &&
    deobfuscateKey(legacyState.target || "") === target &&
    deobfuscateKey(legacyState.user || "") === user);
  const matchingLast = !!(target && last && last.ok === true &&
    deobfuscateKey(last.target || "") === target &&
    deobfuscateKey(last.user || "") === user);
  let value = "off";
  if (matchingState || matchingLegacyState || matchingLast) {
    try {
      const legacy = await pbpReadSettingsWithSecrets(PBP_WEBDAV_AUTO_PUSH_KEY);
      value = pbpWebdavNormalizeAutoPush(legacy[PBP_WEBDAV_AUTO_PUSH_KEY]);
    } catch (_) {}
  }
  return pbpWebdavWriteAutoPush(value);
}

// Whitelist-builds the push payload: every SETTINGS_DEFAULTS key EXCEPT the
// API_KEY_FIELDS, belt-stripped of exportTargets tokens, wrapped in a
// schema/meta envelope. Pure: meta.pushedAt/appVersion are supplied by the
// caller -- this function never touches Date.now() or chrome.runtime, so the
// exact same input always produces the exact same output (verified by the
// "no internal clock" test).
function pbpWebdavBuildPayload(settings, meta, extra) {
  return pbpBuildBackupSnapshot(settings, extra, {
    includeWebdavTransport: false,
    webdavMeta: meta || {},
  });
}

function pbpWebdavPreparePullPayload(data) {
  const payload = Object.assign({}, data || {});
  ["webdavUrl", "webdavUser", "webdavPass", "webdavAutoPush"].forEach((key) => {
    delete payload[key];
  });
  return payload;
}

const PBP_WEBDAV_PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

// Builds a {url, method, headers} request descriptor for WebDAV actions.
function pbpWebdavBuildRequest(kind, cfg, url) {
  cfg = cfg || {};
  const headers = {};
  const auth = pbpWebdavAuthHeader(cfg.user, cfg.pass);
  if (auth) headers["Authorization"] = auth;
  if (kind === "probe") {
    headers.Depth = "0";
    headers["Content-Type"] = "application/xml; charset=utf-8";
    return { url, method: "PROPFIND", headers, body: PBP_WEBDAV_PROPFIND_BODY };
  }
  if (kind === "mkdir") return { url, method: "MKCOL", headers };
  if (kind === "write-test") {
    headers["Content-Type"] = "text/plain";
    headers["If-None-Match"] = "*";
    return { url, method: "PUT", headers, body: "ok" };
  }
  if (kind === "write-test-delete") return { url, method: "DELETE", headers };
  if (kind === "push") {
    headers["Content-Type"] = "application/json";
    if (pbpWebdavValidEtag(cfg.etag)) headers["If-Match"] = cfg.etag.trim();
    else if (cfg.createOnly === true) headers["If-None-Match"] = "*";
    return { url, method: "PUT", headers };
  }
  return { url, method: "GET", headers }; // "pull" | "test"
}

function _pbpWebdavFetch(kind, cfg, url, extra) {
  if (!pbpWebdavOrigin(url)) return Promise.reject(new Error("insecure"));
  const req = pbpWebdavBuildRequest(kind, cfg, url);
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    ...(extra || {}),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
}

function pbpWebdavResponseIsCollection(xml) {
  const blocks = String(xml || "").match(
    /<(?:[A-Za-z_][\w.-]*:)?resourcetype\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?resourcetype\s*>/gi
  ) || [];
  return blocks.some((block) =>
    /<(?:[A-Za-z_][\w.-]*:)?collection\b[^>]*\/?>/i.test(block)
  );
}

async function pbpWebdavProbeCollection(cfg, url) {
  const response = await _pbpWebdavFetch("probe", cfg, url);
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "auth", status: response.status, stage: "propfind" };
  }
  if (response.status === 404) {
    return { ok: false, error: "not-found", status: 404, stage: "propfind" };
  }
  if (!response.ok) {
    return { ok: false, error: "http", status: response.status, stage: "propfind" };
  }
  const xml = await response.text();
  return pbpWebdavResponseIsCollection(xml)
    ? { ok: true }
    : { ok: false, error: "not-collection", status: response.status, stage: "propfind" };
}

function pbpWebdavCollectionSteps(baseUrl, encodedRelativePath) {
  const base = pbpWebdavCollectionUrl(baseUrl);
  if (!base) return [];
  const parts = String(encodedRelativePath || "").split("/").filter(Boolean);
  const out = [];
  const url = new URL(base);
  for (const part of parts) {
    url.pathname += part + "/";
    out.push(url.href);
  }
  return out;
}

async function pbpWebdavEnsureCollectionPath(cfg, target, relativePath) {
  const base = await pbpWebdavProbeCollection(cfg, target.baseCollectionUrl);
  if (!base.ok) return Object.assign(base, { stage: "base-propfind" });
  if (!String(relativePath || "").trim()) return { ok: true };
  const normalized = pbpWebdavNormalizeRelativePath(relativePath);
  if (!normalized.ok) return { ok: false, error: "relative-path", stage: "validate" };
  for (const url of pbpWebdavCollectionSteps(target.baseCollectionUrl, normalized.encoded)) {
    const probe = await pbpWebdavProbeCollection(cfg, url);
    if (probe.ok) continue;
    if (probe.error !== "not-found") return probe;
    const made = await _pbpWebdavFetch("mkdir", cfg, url);
    if (!(made.ok || made.status === 405)) {
      return {
        ok: false,
        error: made.status === 401 || made.status === 403 ? "auth" : "mkdir",
        status: made.status,
        stage: "mkdir",
        url,
      };
    }
    const verified = await pbpWebdavProbeCollection(cfg, url);
    if (!verified.ok) return Object.assign(verified, { stage: "mkdir-verify", url });
  }
  return { ok: true };
}

async function pbpWebdavEnsureCollection(cfg) {
  const baseCollectionUrl = pbpWebdavCollectionUrl(cfg && cfg.baseUrl);
  if (!pbpWebdavOrigin(baseCollectionUrl)) return { ok: false, error: "insecure" };
  const dir = await pbpWebdavProbeCollection(cfg, baseCollectionUrl);
  if (dir.ok) return { ok: true };
  if (dir.error !== "not-found") return dir;
  const made = await _pbpWebdavFetch("mkdir", cfg, baseCollectionUrl);
  if (!(made.ok || made.status === 405)) {
    return { ok: false, error: made.status === 401 || made.status === 403 ? "auth" : "not-found", status: made.status };
  }
  return pbpWebdavProbeCollection(cfg, baseCollectionUrl);
}

async function pbpWebdavProbeWritable(cfg, target) {
  if (!target || !pbpWebdavOrigin(target.baseCollectionUrl) ||
      !pbpWebdavOrigin(target.backupCollectionUrl)) {
    return { ok: false, error: "insecure" };
  }
  const ensured = target.relativePath
    ? await pbpWebdavEnsureCollectionPath(cfg, target, target.relativePath)
    : await pbpWebdavEnsureCollection(cfg);
  if (!ensured.ok) return ensured;
  const name = PBP_WEBDAV_WRITE_TEST_PREFIX + crypto.randomUUID() + ".txt";
  const url = pbpWebdavCollectionFileUrl(target.backupCollectionUrl, name);
  const put = await _pbpWebdavFetch("write-test", cfg, url);
  if (put.status === 401 || put.status === 403) {
    return { ok: false, error: "auth", status: put.status, stage: "write-test" };
  }
  if (!put.ok) {
    return { ok: false, error: "not-writable", status: put.status, stage: "write-test" };
  }
  try {
    const removed = await _pbpWebdavFetch("write-test-delete", cfg, url);
    return removed.ok
      ? { ok: true }
      : { ok: true, cleanupWarning: true, cleanupStatus: removed.status };
  } catch (_) {
    return { ok: true, cleanupWarning: true };
  }
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

async function pbpWebdavPersistPushResult(cfg, result) {
  const stored = Object.assign({}, result, {
    targetId: await pbpWebdavTargetId(cfg).catch(() => ""),
  });
  if (stored.ok) {
    stored.target = obfuscateKey(pbpWebdavFileUrl(cfg.baseUrl));
    stored.user = obfuscateKey(String(cfg.user || ""));
  }
  await chrome.storage.local.set({ webdavLastPush: stored }).catch(() => {});
  return stored;
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
    return pbpWebdavPersistPushResult(cfg, result);
  }
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const result = { ts: Date.now(), ok: false, error: "perm" };
      return pbpWebdavPersistPushResult(cfg, result);
    }
  } catch (_) {
    const result = { ts: Date.now(), ok: false, error: "perm" };
    return pbpWebdavPersistPushResult(cfg, result);
  }
  try {
    const ensured = await pbpWebdavEnsureCollection(cfg);
    if (!ensured.ok) {
      const result = { ts: Date.now(), ok: false, error: ensured.error };
      return pbpWebdavPersistPushResult(cfg, result);
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
    const force = cfgOverride && cfgOverride.force === true;
    const uploaded = await pbpWebdavUploadText(cfg, JSON.stringify(payload), { force });
    const result = Object.assign({ ts: Date.now() }, uploaded);
    if (uploaded.error === "http-404") {
      result.error = "not-found";
      try {
        const dir = await pbpWebdavProbeCollection(cfg, pbpWebdavCollectionUrl(cfg.baseUrl));
        if (dir.ok) result.error = "not-writable";
      } catch (_) {}
    }
    return pbpWebdavPersistPushResult(cfg, result);
  } catch (e) {
    const result = { ts: Date.now(), ok: false, error: (e && e.message) || "network" };
    return pbpWebdavPersistPushResult(cfg, result);
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
  const remote = await pbpWebdavReadRemote(cfg);
  if (!remote.ok) return remote;
  if (!remote.exists) return { ok: false, error: "not-found" };
  return {
    ok: true,
    data: remote.data,
    text: remote.text,
    etag: remote.etag,
    remoteHash: remote.remoteHash,
    settingsHash: remote.settingsHash,
  };
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
    const baseCollectionUrl = pbpWebdavCollectionUrl(cfg.baseUrl);
    const target = { baseCollectionUrl, backupCollectionUrl: baseCollectionUrl, relativePath: "" };
    const resp = await _pbpWebdavFetch("test", cfg, pbpWebdavFileUrl(cfg.baseUrl));
    if (resp.status === 401 || resp.status === 403) return { ok: false, kind: "auth" };
    if (resp.status === 404) {
      const writable = await pbpWebdavProbeWritable(cfg, target);
      return writable.ok ? { ok: true, kind: "empty" } : { ok: false, kind: writable.error, status: writable.status };
    }
    if (resp.ok) {
      const writable = await pbpWebdavProbeWritable(cfg, target);
      return writable.ok ? { ok: true, kind: "found" } : { ok: false, kind: writable.error, status: writable.status };
    }
    return { ok: false, kind: "unreachable" };
  } catch (_) {
    return { ok: false, kind: "unreachable" };
  }
}
