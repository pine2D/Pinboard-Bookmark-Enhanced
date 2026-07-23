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
const PBP_WEBDAV_PENDING_LAYOUT_VERSION = 1;
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
  if (cfg && cfg.targetId) return String(cfg.targetId);
  const target = await pbpWebdavFreezeTarget(cfg);
  return target.ok ? target.targetId : "";
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
  const decodedSegments = [];
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch (_) { return { ok: false, error: "encoding" }; }
    if (!decoded || decoded === "." || decoded === ".." ||
        decoded.includes("/") || decoded.includes("\\")) {
      return { ok: false, error: "segment" };
    }
    decodedSegments.push(decoded);
  }
  return {
    ok: true,
    value: decodedSegments.map(
      (segment) => segment.replace(/%/g, "%25")).join("/") + "/",
    encoded: decodedSegments.map((segment) => encodeURIComponent(segment)).join("/") + "/",
  };
}

function pbpWebdavSplitLegacyCollection(value) {
  const legacyCollectionUrl = pbpWebdavCollectionUrl(value);
  if (!legacyCollectionUrl || !pbpWebdavOrigin(legacyCollectionUrl)) {
    return { ok: false, error: "base-url" };
  }
  const url = new URL(legacyCollectionUrl);
  const parts = url.pathname.replace(/\/+$/, "").split("/");
  const lastEncoded = parts.pop();
  if (!lastEncoded) return { ok: false, error: "root" };
  const path = pbpWebdavNormalizeRelativePath(lastEncoded);
  if (!path.ok) return path;
  url.pathname = parts.join("/") + "/";
  const managed = path.value === PBP_WEBDAV_APP_COLLECTION + "/";
  return {
    ok: true,
    baseUrl: url.href,
    folderMode: managed ? "managed" : "custom",
    relativePath: managed ? "" : path.value,
    legacyCollectionUrl,
  };
}

function pbpWebdavDecideLocation(localPath, remoteLocator) {
  const local = localPath ? pbpWebdavNormalizeRelativePath(localPath) : null;
  if (!remoteLocator || remoteLocator.exists === false) {
    return {
      kind: "local",
      relativePath: local?.ok ? local.value : PBP_WEBDAV_APP_COLLECTION + "/",
    };
  }
  if (!remoteLocator.ok) return { kind: "invalid-remote" };
  if (!local?.ok) {
    return { kind: "adopt", relativePath: remoteLocator.relativePath };
  }
  if (local.value === remoteLocator.relativePath) {
    return { kind: "same", relativePath: local.value };
  }
  return {
    kind: "choose",
    localPath: local.value,
    remotePath: remoteLocator.relativePath,
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

async function pbpWebdavReadState(target) {
  const targetId = String(target && target.targetId || "");
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

async function pbpWebdavRememberState(target, next) {
  const targetId = String(target && target.targetId || "");
  if (!targetId) return false;
  const state = Object.assign(pbpWebdavEmptyState(), next || {});
  delete state.known;
  state.targetId = targetId;
  await chrome.storage.local.set({ [PBP_WEBDAV_SYNC_STATE_KEY]: state });
  return true;
}

async function pbpWebdavReadRemote(cfg, target) {
  try {
    const resp = await _pbpWebdavFetch("pull", cfg, target.backupFileUrl);
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

async function pbpWebdavDecisionResult(target, state, remote, decision) {
  if (["remote-changed", "diverged", "unpaired"].includes(decision)) {
    await pbpWebdavRememberState(target, Object.assign({}, state, {
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

async function pbpWebdavAdoptRemote(target, remote, preferredMode) {
  const mode = preferredMode === "hash" || !remote.etag ? "hash" : "etag";
  await pbpWebdavRememberState(target, {
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

async function pbpWebdavUploadText(cfg, target, text, options) {
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
  const state = await pbpWebdavReadState(target);
  let remote = await pbpWebdavReadRemote(cfg, target);
  if (!remote.ok) return remote;

  let decision = pbpWebdavDecide({
    baselineHash: state.settingsHash,
    localHash,
    remoteHash: remote.settingsHash,
    hasBaseline: state.known,
    remoteExists: remote.exists,
  });
  if (decision === "same") return pbpWebdavAdoptRemote(target, remote, state.mode);
  if (!options.force && decision !== "push" && decision !== "create") {
    return pbpWebdavDecisionResult(target, state, remote, decision);
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

  let resp = await _pbpWebdavFetch("push", pushCfg, target.backupFileUrl, { body: text });
  if (resp.status === 412) {
    remote = await pbpWebdavReadRemote(cfg, target);
    if (!remote.ok) return remote;
    decision = pbpWebdavDecide({
      baselineHash: state.settingsHash,
      localHash,
      remoteHash: remote.settingsHash,
      hasBaseline: state.known,
      remoteExists: remote.exists,
    });
    if (decision === "same") return pbpWebdavAdoptRemote(target, remote, state.mode);
    if (decision !== "push" || options.force) {
      return pbpWebdavDecisionResult(target, state, remote, decision);
    }

    if (!remote.etag) {
      mode = "hash";
      resp = await _pbpWebdavFetch("push", cfg, target.backupFileUrl, { body: text });
    } else {
      const retryCfg = Object.assign({}, cfg, { etag: remote.etag });
      resp = await _pbpWebdavFetch("push", retryCfg, target.backupFileUrl, { body: text });
      if (resp.status === 412) {
        remote = await pbpWebdavReadRemote(cfg, target);
        if (!remote.ok) return remote;
        decision = pbpWebdavDecide({
          baselineHash: state.settingsHash,
          localHash,
          remoteHash: remote.settingsHash,
          hasBaseline: state.known,
          remoteExists: remote.exists,
        });
        if (decision === "same") return pbpWebdavAdoptRemote(target, remote, state.mode);
        if (decision !== "push") return pbpWebdavDecisionResult(target, state, remote, decision);
        mode = "hash";
        resp = await _pbpWebdavFetch("push", cfg, target.backupFileUrl, { body: text });
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

  const verified = await pbpWebdavReadRemote(cfg, target);
  if (!verified.ok || !verified.exists || verified.remoteHash !== uploadedHash) {
    return {
      ok: false,
      error: "verify-failed",
      cause: verified.ok ? "content-mismatch" : verified.error,
    };
  }
  if (mode !== "hash") mode = verified.etag ? "etag" : "hash";
  await pbpWebdavRememberState(target, {
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

async function pbpWebdavPrepareOperation(cfg) {
  const frozenCfg = Object.assign({}, cfg || {});
  const target = await pbpWebdavFreezeTarget(frozenCfg);
  return target.ok ? { ok: true, cfg: frozenCfg, target } : target;
}

function pbpWebdavParseLocator(text) {
  let value;
  try { value = JSON.parse(String(text)); }
  catch (_) { return { ok: false, error: "invalid-locator" }; }
  if (!pbpIsPlainRecord(value) || value.schemaVersion !== 1) {
    return { ok: false, error: "invalid-locator" };
  }
  const path = pbpWebdavNormalizeRelativePath(value.relativePath);
  return path.ok
    ? { ok: true, relativePath: path.value }
    : { ok: false, error: "invalid-locator" };
}

function pbpWebdavLocatorText(relativePath) {
  return JSON.stringify({ schemaVersion: 1, relativePath });
}

async function pbpWebdavReadLocator(cfg, target) {
  try {
    const response = await _pbpWebdavFetch("pull", cfg, target.locatorFileUrl);
    if (response.status === 404) return { ok: true, exists: false };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "auth", status: response.status, stage: "locator-get" };
    }
    if (!response.ok) {
      return { ok: false, error: "http", status: response.status, stage: "locator-get" };
    }
    const text = await response.text();
    const parsed = pbpWebdavParseLocator(text);
    if (!parsed.ok) return Object.assign(parsed, { stage: "locator-parse" });
    return Object.assign(parsed, {
      exists: true,
      etag: pbpWebdavResponseEtag(response),
      hash: await pbpWebdavSha256(text),
    });
  } catch (_) {
    return { ok: false, error: "http", stage: "locator-get" };
  }
}

async function pbpWebdavWriteLocator(cfg, target, nextRelativePath, expectedRemotePath) {
  const next = pbpWebdavNormalizeRelativePath(nextRelativePath);
  const expected = pbpWebdavNormalizeRelativePath(expectedRemotePath);
  if (!next.ok || !expected.ok) {
    return { ok: false, error: "invalid-locator", stage: "locator-validate" };
  }
  const ensured = await pbpWebdavEnsureCollectionPath(
    cfg, target, PBP_WEBDAV_APP_COLLECTION + "/");
  if (!ensured.ok) return ensured;

  const current = await pbpWebdavReadLocator(cfg, target);
  if (!current.ok) return current;
  if (current.exists && current.relativePath === next.value) return { ok: true, noop: true };
  if (current.exists && current.relativePath !== expected.value) {
    return { ok: false, error: "locator-conflict", stage: "locator-compare" };
  }
  if (current.exists && !current.etag) {
    return {
      ok: false,
      error: "locator-conflict",
      stage: "locator-compare",
      reason: "missing-etag",
    };
  }

  const text = pbpWebdavLocatorText(next.value);
  const putCfg = Object.assign({}, cfg);
  if (current.etag) putCfg.etag = current.etag;
  else if (!current.exists) putCfg.createOnly = true;
  let response;
  try {
    response = await _pbpWebdavFetch("push", putCfg, target.locatorFileUrl, { body: text });
  } catch (_) {
    return { ok: false, error: "http", stage: "locator-put" };
  }
  if (response.status === 409 || response.status === 412) {
    return {
      ok: false,
      error: "locator-conflict",
      status: response.status,
      stage: "locator-put",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: response.status === 401 || response.status === 403 ? "auth" : "http",
      status: response.status,
      stage: "locator-put",
    };
  }
  if (current.etag) return { ok: true };

  const verified = await pbpWebdavReadLocator(cfg, target);
  const hash = await pbpWebdavSha256(text);
  return verified.ok && verified.exists && verified.hash === hash
    ? { ok: true }
    : {
      ok: false,
      error: "locator-verify",
      stage: "locator-verify",
      status: verified.status,
    };
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
  if (Number(s.webdavLayoutVersion || 0) !== PBP_WEBDAV_LAYOUT_VERSION) return 0;
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
  const legacyTargetId = target ? await pbpWebdavSha256(target + "\n" + user) : "";
  const state = local[PBP_WEBDAV_SYNC_STATE_KEY];
  const legacyState = local._webdavEtagState;
  const last = local.webdavLastPush;
  const matchingState = !!((targetId || legacyTargetId) &&
    pbpIsPlainRecord(state) && state.settingsHash &&
    (state.targetId === targetId || state.targetId === legacyTargetId));
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
  [
    "webdavUrl", "webdavUser", "webdavPass", "webdavAutoPush",
    "webdavFolderMode", "webdavRelativePath", "webdavLayoutVersion",
  ].forEach((key) => {
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
    /<(?:[A-Za-z_][\w.-]*:)?resourcetype(?=[\s/>])[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?resourcetype\s*>/gi
  ) || [];
  return blocks.some((block) =>
    /<(?:[A-Za-z_][\w.-]*:)?collection(?=[\s/>])[^>]*\/?>/i.test(block)
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

async function pbpWebdavEnsureCollectionUrl(cfg, baseCollectionUrl) {
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

async function pbpWebdavEnsureCollection(cfg) {
  return pbpWebdavEnsureCollectionUrl(cfg, pbpWebdavCollectionUrl(cfg && cfg.baseUrl));
}

async function pbpWebdavProbeWritable(cfg, target, options) {
  if (!target || !pbpWebdavOrigin(target.baseCollectionUrl) ||
      !pbpWebdavOrigin(target.backupCollectionUrl)) {
    return { ok: false, error: "insecure" };
  }
  const ensured = options?.create === false
    ? await pbpWebdavProbeCollection(cfg, target.backupCollectionUrl)
    : target.relativePath
      ? await pbpWebdavEnsureCollectionPath(cfg, target, target.relativePath)
      : await pbpWebdavEnsureCollectionUrl(cfg, target.baseCollectionUrl);
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

async function pbpWebdavInspectLegacyLayout(cfg) {
  cfg = cfg || {};
  if (!String(cfg.baseUrl || "").trim()) return { kind: "not-configured" };

  const diagnostic = (result) => [
    result?.stage || "",
    result?.error || "unavailable",
    Number.isFinite(result?.status) ? result.status : "",
  ].filter((part) => part !== "").join(":");
  const split = pbpWebdavSplitLegacyCollection(cfg.baseUrl);
  let preserveError = split.ok ? "target-mismatch" : split.error;
  if (split.ok) {
    const preserveCfg = Object.assign({}, cfg, {
      baseUrl: split.baseUrl,
      folderMode: split.folderMode,
      relativePath: split.relativePath,
    });
    const target = await pbpWebdavFreezeTarget(preserveCfg);
    if (target.ok && target.backupCollectionUrl === split.legacyCollectionUrl) {
      let writable;
      try {
        writable = await pbpWebdavProbeWritable(
          preserveCfg, target, { create: false });
      } catch (_) {
        writable = { ok: false, error: "network" };
      }
      if (writable.ok) {
        return {
          kind: "preserve",
          candidate: split,
          target,
          cleanupWarning: !!writable.cleanupWarning,
          cleanupStatus: writable.cleanupStatus,
        };
      }
      preserveError = diagnostic(writable);
    }
  }

  const managedCfg = Object.assign({}, cfg, {
    folderMode: "managed",
    relativePath: "",
  });
  const managedTarget = await pbpWebdavFreezeTarget(managedCfg);
  let writable = { ok: false, error: managedTarget.error || "unavailable" };
  if (managedTarget.ok) {
    try {
      writable = await pbpWebdavProbeWritable(
        managedCfg, managedTarget, { create: false });
    } catch (_) {
      writable = { ok: false, error: "network" };
    }
  }
  if (writable.ok) {
    return {
      kind: "managed",
      candidate: managedCfg,
      target: managedTarget,
      cleanupWarning: !!writable.cleanupWarning,
      cleanupStatus: writable.cleanupStatus,
    };
  }
  if (managedTarget.ok && writable.error === "not-found") {
    let base;
    try {
      base = await pbpWebdavProbeCollection(
        managedCfg, managedTarget.baseCollectionUrl);
    } catch (_) {
      base = { ok: false, error: "network" };
    }
    if (base.ok) {
      return {
        kind: "managed",
        candidate: managedCfg,
        target: managedTarget,
        needsCreate: true,
      };
    }
    writable = base;
  }
  return {
    kind: "manual",
    preserveError,
    managedError: diagnostic(writable),
  };
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
function pbpWebdavCfgFromSettings(settings) {
  const s = settings || {};
  return {
    baseUrl: deobfuscateKey(s.webdavUrl || ""),
    user: deobfuscateKey(s.webdavUser || ""),
    pass: deobfuscateKey(s.webdavPass || ""),
    folderMode: s.webdavFolderMode === "custom" ? "custom" : "managed",
    relativePath: String(s.webdavRelativePath || ""),
    layoutVersion: Number(s.webdavLayoutVersion || 0),
  };
}

async function _pbpWebdavCfg() {
  const s = await pbpReadSettingsWithSecrets({
    webdavUrl: "",
    webdavUser: "",
    webdavPass: "",
    webdavFolderMode: "managed",
    webdavRelativePath: "",
    webdavLayoutVersion: 0,
  });
  return pbpWebdavCfgFromSettings(s);
}

async function pbpWebdavPersistPushResult(cfg, target, result) {
  const stored = Object.assign({}, result, {
    targetId: String(target && target.targetId || ""),
  });
  if (target && target.ok) {
    stored.target = obfuscateKey(target.backupFileUrl);
    stored.user = obfuscateKey(target.user);
  }
  await chrome.storage.local.set({ webdavLastPush: stored }).catch(() => {});
  return target && target.ok
    ? Object.assign({}, stored, {
      targetBinding: JSON.stringify([target.backupFileUrl, target.user]),
    })
    : stored;
}

// Test button / Push now / Pull now in options.js pass a cfgOverride built
// straight from the live form fields, so a click right after typing never
// races the 500ms debounced auto-save (same reasoning as options-connectivity
// .js's testAIProvider, which reads DOM values rather than storage).

async function pbpWebdavPush(cfgOverride) {
  let cfg = cfgOverride ? Object.assign({}, cfgOverride) : await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, error: "no-url" };
  const prepared = await pbpWebdavPrepareOperation(cfg);
  if (!prepared.ok) {
    const result = { ts: Date.now(), ok: false, error: "insecure" };
    return pbpWebdavPersistPushResult(cfg, null, result);
  }
  cfg = prepared.cfg;
  const target = prepared.target;
  const origin = pbpWebdavOrigin(target.baseCollectionUrl);
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const result = { ts: Date.now(), ok: false, error: "perm" };
      return pbpWebdavPersistPushResult(cfg, target, result);
    }
  } catch (_) {
    const result = { ts: Date.now(), ok: false, error: "perm" };
    return pbpWebdavPersistPushResult(cfg, target, result);
  }
  try {
    const ensured = await pbpWebdavEnsureCollectionPath(cfg, target, target.relativePath);
    if (!ensured.ok) {
      const result = {
        ts: Date.now(),
        ok: false,
        error: ensured.error,
        status: ensured.status,
        stage: ensured.stage,
      };
      return pbpWebdavPersistPushResult(cfg, target, result);
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
    const force = cfg.force === true;
    const uploaded = await pbpWebdavUploadText(cfg, target, JSON.stringify(payload), { force });
    const result = Object.assign({ ts: Date.now() }, uploaded);
    if (uploaded.error === "http-404") {
      result.error = "not-found";
      try {
        const dir = await pbpWebdavProbeCollection(cfg, target.backupCollectionUrl);
        if (dir.ok) result.error = "not-writable";
      } catch (_) {}
    }
    if (uploaded.ok) {
      const locator = await pbpWebdavWriteLocator(
        cfg, target, target.relativePath, target.relativePath);
      if (!locator.ok) {
        result.locatorWarning = locator.error;
        result.locatorStage = locator.stage;
        result.locatorStatus = locator.status;
      }
    }
    return pbpWebdavPersistPushResult(cfg, target, result);
  } catch (e) {
    const result = { ts: Date.now(), ok: false, error: (e && e.message) || "network" };
    return pbpWebdavPersistPushResult(cfg, target, result);
  }
}

async function pbpWebdavPull(cfgOverride) {
  let cfg = cfgOverride ? Object.assign({}, cfgOverride) : await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, error: "no-url" };
  const prepared = await pbpWebdavPrepareOperation(cfg);
  if (!prepared.ok) return { ok: false, error: "insecure" };
  cfg = prepared.cfg;
  const target = prepared.target;
  const origin = pbpWebdavOrigin(target.baseCollectionUrl);
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, error: "perm" };
  } catch (_) { return { ok: false, error: "perm" }; }
  const remote = await pbpWebdavReadRemote(cfg, target);
  if (!remote.ok) return remote;
  if (!remote.exists) return { ok: false, error: "not-found" };
  return {
    ok: true,
    data: remote.data,
    text: remote.text,
    etag: remote.etag,
    remoteHash: remote.remoteHash,
    settingsHash: remote.settingsHash,
    target,
  };
}

async function pbpWebdavTest(cfgOverride) {
  let cfg = cfgOverride ? Object.assign({}, cfgOverride) : await _pbpWebdavCfg();
  if (!cfg.baseUrl) return { ok: false, kind: "no-url" };
  const prepared = await pbpWebdavPrepareOperation(cfg);
  if (!prepared.ok) return { ok: false, kind: "insecure" };
  cfg = prepared.cfg;
  const target = prepared.target;
  const origin = pbpWebdavOrigin(target.baseCollectionUrl);
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return { ok: false, kind: "perm" };
  } catch (_) { return { ok: false, kind: "perm" }; }
  try {
    const resp = await _pbpWebdavFetch("test", cfg, target.backupFileUrl);
    if (resp.status === 401 || resp.status === 403) return { ok: false, kind: "auth" };
    if (resp.status !== 404 && !resp.ok) return { ok: false, kind: "unreachable" };
    const writable = await pbpWebdavProbeWritable(cfg, target);
    if (!writable.ok) {
      const detailStage = writable.stage || "";
      const uiStage = detailStage === "base-propfind"
        ? "base-collection"
        : detailStage === "write-test"
          ? "write"
          : "backup-collection";
      return {
        ok: false,
        kind: writable.error,
        status: writable.status,
        stage: writable.stage,
        detailStage,
        uiStage,
      };
    }
    const locator = await pbpWebdavWriteLocator(
      cfg, target, target.relativePath, target.relativePath);
    if (!locator.ok) {
      return {
        ok: false,
        kind: locator.error,
        status: locator.status,
        stage: locator.stage,
        detailStage: locator.stage || "",
        uiStage: "locator",
      };
    }
    return Object.assign(
      { ok: true, kind: resp.status === 404 ? "empty" : "found" },
      writable.cleanupWarning
        ? {
          cleanupWarning: true,
          cleanupStatus: writable.cleanupStatus,
          uiStage: "cleanup",
        }
        : {}
    );
  } catch (_) {
    return { ok: false, kind: "unreachable" };
  }
}
